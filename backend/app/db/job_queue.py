from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

logger = logging.getLogger(__name__)

_engine: AsyncEngine | None = None
_sessions: async_sessionmaker[AsyncSession] | None = None
_worker_task: asyncio.Task[None] | None = None
_MAX_ATTEMPTS = 5


class JobQueueConfigurationError(RuntimeError):
    pass


def _session_factory() -> async_sessionmaker[AsyncSession]:
    if _sessions is None:
        raise JobQueueConfigurationError("QUEUE_DATABASE_URL is not configured")
    return _sessions


async def init_job_queue() -> None:
    global _engine, _sessions
    queue_url = os.getenv("QUEUE_DATABASE_URL")
    if not queue_url:
        if os.getenv("APP_ENV") == "production":
            raise JobQueueConfigurationError("QUEUE_DATABASE_URL is required in production")
        return
    if not queue_url.startswith("postgresql+asyncpg://"):
        raise JobQueueConfigurationError("QUEUE_DATABASE_URL must use PostgreSQL with asyncpg")

    _engine = create_async_engine(queue_url, pool_pre_ping=True)
    _sessions = async_sessionmaker(_engine, class_=AsyncSession, expire_on_commit=False)
    async with _engine.begin() as connection:
        await connection.execute(text("""
            CREATE TABLE IF NOT EXISTS backend_pipeline_jobs (
                id TEXT PRIMARY KEY,
                dedupe_key TEXT NOT NULL UNIQUE,
                payload JSONB NOT NULL,
                status TEXT NOT NULL DEFAULT 'QUEUED',
                attempts INTEGER NOT NULL DEFAULT 0,
                available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                locked_at TIMESTAMPTZ,
                result JSONB,
                last_error TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """))
        await connection.execute(text("""
            ALTER TABLE backend_pipeline_jobs
            ADD COLUMN IF NOT EXISTS result JSONB
        """))
        await connection.execute(text("""
            CREATE INDEX IF NOT EXISTS backend_pipeline_jobs_ready_idx
            ON backend_pipeline_jobs (status, available_at, created_at)
        """))


async def close_job_queue() -> None:
    global _engine, _sessions, _worker_task
    if _worker_task is not None:
        _worker_task.cancel()
        try:
            await _worker_task
        except asyncio.CancelledError:
            pass
        _worker_task = None
    if _engine is not None:
        await _engine.dispose()
        _engine = None
        _sessions = None


async def enqueue_github_push(payload: dict[str, Any], dedupe_key: str) -> str:
    job_id = str(uuid.uuid4())
    async with _session_factory()() as database:
        await database.execute(
            text("""
                INSERT INTO backend_pipeline_jobs (id, dedupe_key, payload)
                VALUES (:id, :dedupe_key, CAST(:payload AS JSONB))
                ON CONFLICT (dedupe_key) DO NOTHING
            """),
            {
                "id": job_id,
                "dedupe_key": dedupe_key,
                "payload": json.dumps(payload),
            },
        )
        result = await database.execute(
            text("SELECT id FROM backend_pipeline_jobs WHERE dedupe_key = :dedupe_key"),
            {"dedupe_key": dedupe_key},
        )
        queued_id = str(result.scalar_one())
        await database.commit()
        return queued_id


async def get_job(job_id: str) -> dict[str, Any] | None:
    async with _session_factory()() as database:
        result = await database.execute(
            text("""
                SELECT id, status, attempts, result, last_error, created_at, updated_at
                FROM backend_pipeline_jobs
                WHERE id = :id
            """),
            {"id": job_id},
        )
        row = result.mappings().first()
        return dict(row) if row is not None else None


async def start_job_worker() -> None:
    global _worker_task
    if _sessions is not None and _worker_task is None:
        _worker_task = asyncio.create_task(_run_worker(), name="backend-pipeline-job-worker")


async def _claim_job() -> dict[str, Any] | None:
    async with _session_factory()() as database:
        async with database.begin():
            result = await database.execute(text("""
                WITH candidate AS (
                    SELECT id FROM backend_pipeline_jobs
                    WHERE (status = 'QUEUED' AND available_at <= now())
                       OR (status = 'RUNNING' AND locked_at < now() - interval '5 minutes')
                    ORDER BY available_at, created_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                UPDATE backend_pipeline_jobs AS job
                SET status = 'RUNNING', attempts = job.attempts + 1,
                    locked_at = now(), updated_at = now()
                FROM candidate
                WHERE job.id = candidate.id
                RETURNING job.id, job.payload, job.attempts
            """))
            row = result.mappings().first()
            return dict(row) if row is not None else None


async def _finish_job(job_id: str, result: dict[str, str]) -> None:
    async with _session_factory()() as database:
        await database.execute(
            text("""
                UPDATE backend_pipeline_jobs
                SET status = 'COMPLETED', result = CAST(:result AS JSONB), locked_at = NULL,
                    last_error = NULL, updated_at = now()
                WHERE id = :id
            """),
            {"id": job_id, "result": json.dumps(result)},
        )
        await database.commit()


async def _fail_job(job: dict[str, Any], error: Exception) -> None:
    attempts = int(job["attempts"])
    failed = attempts >= _MAX_ATTEMPTS
    retry_seconds = min(300, 5 * (2**attempts))
    async with _session_factory()() as database:
        await database.execute(
            text("""
                UPDATE backend_pipeline_jobs
                SET status = :status,
                    available_at = CASE WHEN :status = 'QUEUED'
                        THEN now() + (:delay * interval '1 second') ELSE available_at END,
                    locked_at = NULL, last_error = :error, updated_at = now()
                WHERE id = :id
            """),
            {
                "id": job["id"],
                "status": "FAILED" if failed else "QUEUED",
                "delay": retry_seconds,
                "error": f"Execution failed ({type(error).__name__})",
            },
        )
        await database.commit()
    logger.error(
        "Pipeline job failed",
        extra={"job_id": job["id"], "attempt": attempts, "will_retry": not failed,
               "error_type": type(error).__name__},
    )


async def _execute_job(job: dict[str, Any]) -> dict[str, str]:
    from app.api.schemas import GitHubPushPayload
    from app.api.webhooks import process_github_push

    payload = GitHubPushPayload.model_validate(job["payload"])
    return await process_github_push(payload)


async def _run_worker() -> None:
    while True:
        try:
            job = await _claim_job()
            if job is None:
                await asyncio.sleep(1)
                continue
            try:
                result = await _execute_job(job)
                await _finish_job(str(job["id"]), result)
            except Exception as error:
                await _fail_job(job, error)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.exception(
                "Pipeline queue worker iteration failed",
                extra={"error_type": type(error).__name__},
            )
            await asyncio.sleep(5)

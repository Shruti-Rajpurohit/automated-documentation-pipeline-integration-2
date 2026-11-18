from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import os
import subprocess
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Request, status
from pydantic import ValidationError

from app.api.schemas import GitHubPushPayload
from app.db.database import async_session_factory
from app.db.job_queue import enqueue_github_push
from app.db.models import User
from app.document_finder import DocumentSearchLimitError
from app.git_tools import GitCommandError, InvalidRevisionError
from app.llm_client import LLMConfigurationError, ModelRequestError, ProposalValidationError, get_llm_client
from app.patch_writer import PatchError
from app.services.pipeline import analyze_repository_change
from app.services.repositories import RepositoryAccessError, RepositoryConfigurationError, validate_repository_paths
from app.services.review import persist_review_draft, persist_review_outcome


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/webhooks", tags=["webhooks"])
_EMPTY_SHA = "0" * 40


def verify_github_signature(secret: str, body: bytes, signature_header: str | None) -> bool:
	if not signature_header or not signature_header.startswith("sha256="):
		return False
	expected = "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
	return hmac.compare_digest(expected, signature_header)


def _normalize_remote(url: str) -> str:
	"""https://github.com/Org/Relay.git / git@github.com:Org/Relay → org/relay"""
	value = url.strip().lower()
	if value.startswith("git@") and ":" in value:
		value = value.split(":", 1)[1]
	else:
		for prefix in ("https://", "http://", "ssh://"):
			if value.startswith(prefix):
				value = value[len(prefix):]
				if "/" in value:
					value = value.split("/", 1)[1]
				break
	return value.removesuffix(".git").rstrip("/")


def _resolve_repo_paths(repo_name: str, full_name: str) -> tuple[str, str] | None:
	"""Map the pushed repo to local checkouts.

	SOURCE_REPO_PATH / DOCS_REPO_PATH pin a single-repo deployment; then a push
	from any other repository is ignored instead of analyzed against the wrong
	tree. Without the pins, the repo is located by name under REPOSITORY_ROOTS,
	with the docs checkout as its '<name>-docs' sibling.
	"""
	pinned_source = os.getenv("SOURCE_REPO_PATH")
	pinned_docs = os.getenv("DOCS_REPO_PATH")
	if pinned_source:
		if Path(pinned_source).name != repo_name:
			return None
		return (pinned_source, pinned_docs or "") if pinned_docs else None

	roots = [r.strip() for r in os.getenv("REPOSITORY_ROOTS", "").split(",") if r.strip()]
	target_remote = _normalize_remote(full_name) if full_name else ""
	candidates: list[Path] = []
	for root in roots:
		for candidate in sorted(Path(root).iterdir()) if Path(root).is_dir() else []:
			if not candidate.is_dir() or candidate.name.endswith("-docs"):
				continue
			# Prefer remote-URL identity over directory names: two checkouts both
			# named 'relay' from different orgs must not collide.
			try:
				remote = subprocess.run(
					["git", "-C", str(candidate), "config", "--get", "remote.origin.url"],
					capture_output=True, text=True, timeout=10,
				).stdout.strip()
			except (OSError, subprocess.TimeoutExpired):
				remote = ""
			if target_remote and remote and _normalize_remote(remote) == target_remote:
				docs = candidate.with_name(f"{candidate.name}-docs")
				if docs.is_dir():
					return str(candidate), str(docs)
				candidates.append(candidate)
			elif candidate.name == repo_name:
				candidates.append(candidate)
	for candidate in candidates:
		docs = candidate.with_name(f"{candidate.name}-docs")
		if docs.is_dir():
			return str(candidate), str(docs)
	return None


async def _already_processed(repository_name: str, before: str, after: str) -> bool:
	"""GitHub redelivers webhooks; commits are the idempotency key."""
	from sqlalchemy import or_, select
	from app.db.models import ReviewSession

	async with async_session_factory() as database:
		result = await database.execute(
			select(ReviewSession.id).where(
				ReviewSession.head_commit == after,
				ReviewSession.source_repo.like(f"%{repository_name}"),
			)
		)
		return result.first() is not None


def _fetch_latest(source_repo: str) -> None:
	"""Best-effort fetch so the pushed commits exist in the local checkout.
	Offline mirrors keep working: if the refs are already present the analysis
	succeeds; if fetch fails and the refs are absent, revision resolution
	raises a clear error downstream."""
	try:
		subprocess.run(["git", "config", "--global", "--add", "safe.directory", source_repo],
			check=False, capture_output=True, timeout=10)
		subprocess.run(
			["git", "-C", source_repo, "fetch", "--all", "--tags", "--prune"],
			check=False,
			capture_output=True,
			timeout=60,
		)
	except (OSError, subprocess.TimeoutExpired) as error:
		logger.warning("git fetch failed for %s: %s", source_repo, error)


async def process_github_push(payload: GitHubPushPayload) -> dict[str, str]:
	full_name = str(payload.repository.get("full_name") or "")
	repo_name = (payload.repository.get("name") or full_name.split("/")[-1]).strip()
	model_name = os.getenv("DEFAULT_MODEL")
	provider = os.getenv("DEFAULT_PROVIDER", "ollama")
	webhook_user_id = os.getenv("WEBHOOK_USER_ID")
	if not model_name or not webhook_user_id:
		raise RuntimeError("Webhook processing requires DEFAULT_MODEL and WEBHOOK_USER_ID")
	if not repo_name:
		logger.error("Webhook payload carries no repository name")
		return {"outcome": "ignored", "reason": "missing_repository_name"}

	paths = _resolve_repo_paths(repo_name, full_name)
	if paths is None:
		logger.info("Ignoring push: no mapped source/docs checkout for repository %s", repo_name)
		return {"outcome": "ignored", "reason": "repository_not_mapped"}
	source_repo, docs_repo = paths

	if await _already_processed(repo_name, payload.before, payload.after):
		logger.info("Ignoring redelivery for commit %s (already processed)", payload.after)
		return {"outcome": "duplicate", "head_revision": payload.after}

	await asyncio.to_thread(_fetch_latest, source_repo)

	async with async_session_factory() as database:
		try:
			user = await database.get(User, int(webhook_user_id))
			if user is None:
				raise RuntimeError(f"Webhook user {webhook_user_id} was not found")
			source_repo, docs_repo = await asyncio.to_thread(
				validate_repository_paths,
				source_repo,
				docs_repo,
				os.getenv("REPOSITORY_ROOTS"),
			)
			model_client = get_llm_client(provider=provider, model=model_name)
			draft = await analyze_repository_change(
				source_repo,
				docs_repo,
				payload.before,
				payload.after,
				model_client,
				model_name=model_name,
				database=database,
			)
			if draft.outcome == "awaiting_review" and draft.proposal is not None and draft.prepared_patch is not None:
				record = await persist_review_draft(
					database,
					draft,
					actor_id=user.id,
					source_repo=source_repo,
					docs_repo=docs_repo,
					model_name=model_name,
				)
				logger.info("Created review session %s for commit %s", record.id, payload.after)
				return {"outcome": draft.outcome, "session_id": str(record.id)}
			# Persist no-update / human-investigation runs — outcomes are audit
			# data, not log lines.
			record = await persist_review_outcome(
				database,
				draft,
				actor_id=user.id,
				source_repo=source_repo,
				docs_repo=docs_repo,
				model_name=model_name,
			)
			logger.info(
				"Recorded %s outcome as session %s for commit %s: %s",
				draft.outcome,
				record.id,
				payload.after,
				draft.note or draft.analysis.rationale,
			)
			return {"outcome": draft.outcome, "session_id": str(record.id)}
		except (
			RepositoryConfigurationError,
			RepositoryAccessError,
			LLMConfigurationError,
			ModelRequestError,
			ProposalValidationError,
			GitCommandError,
			InvalidRevisionError,
			DocumentSearchLimitError,
			PatchError,
			ValueError,
			OSError,
		) as error:
			logger.exception("Webhook processing failed: %s", error)
			raise


@router.post("/github")
async def github_webhook(
	request: Request,
	background_tasks: BackgroundTasks,
	x_hub_signature_256: str | None = Header(default=None, alias="X-Hub-Signature-256"),
	x_github_event: str | None = Header(default=None, alias="X-GitHub-Event"),
) -> dict[str, str]:
	secret = os.getenv("GITHUB_WEBHOOK_SECRET")
	if not secret or (
		os.getenv("APP_ENV") == "production"
		and (len(secret) < 32 or "replace-with" in secret.lower())
	):
		raise HTTPException(
			status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
			detail="Webhook authentication requires a non-placeholder secret of at least 32 characters",
		)
	body = await request.body()
	if not verify_github_signature(secret, body, x_hub_signature_256):
		raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid webhook signature")
	if x_github_event not in {None, "push"}:
		return {"status": "ignored", "message": "Event is not a git push"}

	try:
		payload = GitHubPushPayload.model_validate_json(body)
	except ValidationError as error:
		raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid GitHub push payload") from error
	if not payload.ref.startswith("refs/heads/"):
		return {"status": "ignored", "message": "Push does not update a branch"}
	if payload.after == _EMPTY_SHA:
		return {"status": "ignored", "message": "Push deletes a branch"}
	if payload.before == _EMPTY_SHA:
		# A new branch has no meaningful compare base against prior history;
		# releases from it will arrive as later pushes or tags.
		return {"status": "ignored", "message": "Push creates a branch; no compare base"}
	import re as _re
	allowed = _re.compile(os.getenv("PIPELINE_WEBHOOK_BRANCHES", r"^refs/heads/(main|master|release/.*)$"))
	if not allowed.match(payload.ref):
		return {"status": "ignored", "message": "Branch is not a release line"}

	queue_url = os.getenv("QUEUE_DATABASE_URL")
	if queue_url:
		repository = str(payload.repository.get("full_name") or "")
		dedupe_key = f"github:{repository.lower()}:{payload.after}"
		try:
			job_id = await enqueue_github_push(payload.model_dump(mode="json"), dedupe_key)
		except Exception as error:
			logger.exception("Could not durably enqueue GitHub push: %s", error)
			raise HTTPException(
				status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
				detail="Webhook job could not be queued",
			) from error
		return {"status": "accepted", "job_id": job_id, "message": "Webhook job durably queued"}

	background_tasks.add_task(process_github_push, payload)
	return {"status": "accepted", "message": "Processing pushed changes"}

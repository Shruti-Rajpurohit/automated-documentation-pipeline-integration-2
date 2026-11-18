from __future__ import annotations

import unittest
from unittest.mock import patch

from app.db import job_queue


class _Result:
    def scalar_one(self) -> str:
        return "existing-job-id"


class _Session:
    def __init__(self) -> None:
        self.committed = False

    async def __aenter__(self) -> _Session:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def execute(self, *_: object, **__: object) -> _Result:
        return _Result()

    async def commit(self) -> None:
        self.committed = True


class EnqueueGitHubPushTests(unittest.IsolatedAsyncioTestCase):
    async def test_enqueue_commits_before_returning_job_id(self) -> None:
        session = _Session()
        with patch.object(job_queue, "_sessions", return_value=session):
            job_id = await job_queue.enqueue_github_push(
                {"after": "abc123"},
                "github:example/repo:abc123",
            )

        self.assertEqual(job_id, "existing-job-id")
        self.assertTrue(session.committed)


if __name__ == "__main__":
    unittest.main()

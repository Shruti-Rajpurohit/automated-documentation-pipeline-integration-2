"""Regression tests for the security-review hardening round."""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from app.api.webhooks import _normalize_remote


class RemoteNormalizationTests(unittest.TestCase):
	def test_https_remote(self) -> None:
		self.assertEqual(_normalize_remote("https://github.com/Org/Relay.git"), "org/relay")

	def test_ssh_remote(self) -> None:
		self.assertEqual(_normalize_remote("git@github.com:Org/Relay-Docs.git"), "org/relay-docs")

	def test_enterprise_host(self) -> None:
		self.assertEqual(_normalize_remote("https://git.acme.corp/team/relay"), "team/relay")


class BranchFilterTests(unittest.TestCase):
	def test_default_release_lines(self) -> None:
		import re
		rule = re.compile(os.getenv("PIPELINE_WEBHOOK_BRANCHES", r"^refs/heads/(main|master|release/.*)$"))
		self.assertTrue(rule.match("refs/heads/main"))
		self.assertTrue(rule.match("refs/heads/release/2.4"))
		self.assertIsNone(rule.match("refs/heads/feature/foo"))


class OllamaUrlPolicyTests(unittest.TestCase):
	def test_env_url_used_when_no_request_value(self) -> None:
		from app.llm_client import resolve_ollama_url

		with patch.dict(os.environ, {"OLLAMA_URL": "http://internal:11434"}):
			self.assertEqual(resolve_ollama_url(None), "http://internal:11434")

	def test_arbitrary_url_refused(self) -> None:
		from app.llm_client import LLMConfigurationError, resolve_ollama_url

		env = {k: v for k, v in os.environ.items() if k != "OLLAMA_URL_ALLOWLIST"}
		with patch.dict(os.environ, env, clear=True):
			with self.assertRaises(LLMConfigurationError):
				resolve_ollama_url("http://169.254.169.254/latest")


class PromptSizeGuardTests(unittest.TestCase):
	def test_guard_trips(self) -> None:
		from app.services.pipeline import _render_writer_prompt

		with patch.dict(os.environ, {"PIPELINE_MAX_PROMPT_CHARS": "50"}):
			with self.assertRaises(Exception) as ctx:
				_render_writer_prompt("{{source_context}} {{document_context}}", "{} " * 50, [], "", None, None)
		self.assertIn("exceeds", str(ctx.exception).lower())


if __name__ == "__main__":
	unittest.main()

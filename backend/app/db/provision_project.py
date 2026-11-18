from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from sqlalchemy import select

from app.db.database import async_session_factory, close_db, init_db
from app.db.models import Project


async def create_project(name: str, source_repo: str, docs_repo: str, context: str, *, ensure_existing: bool = False) -> int:
	"""Register a project house style. The pipeline resolves style per
	source_repo, so every repo drafts under its own rules — never another
	project's and never a silent global fallback."""
	await init_db()
	try:
		async with async_session_factory() as database:
			existing = await database.scalar(select(Project).where(Project.source_repo == source_repo))
			if existing is not None:
				if not ensure_existing:
					raise ValueError(f"A project is already registered for {source_repo}")
				existing.name = name
				existing.docs_repo = docs_repo
				existing.context = context
				await database.commit()
				return existing.id
			project = Project(name=name, source_repo=source_repo, docs_repo=docs_repo, context=context)
			database.add(project)
			await database.commit()
			await database.refresh(project)
			return project.id
	finally:
		await close_db()


def main() -> None:
	parser = argparse.ArgumentParser(description="Provision a project (house style) for the documentation pipeline API.")
	parser.add_argument("name", help="Project display name")
	parser.add_argument("source_repo", help="Absolute path to the product source checkout")
	parser.add_argument("docs_repo", help="Absolute path to the documentation checkout")
	parser.add_argument("--context-file", help="Markdown/text file with the project's style guide")
	parser.add_argument("--context", help="Inline style guide text (used when --context-file is absent)")
	parser.add_argument("--ensure", action="store_true", help="Update the project if it already exists")
	args = parser.parse_args()

	if args.context_file:
		context = Path(args.context_file).read_text(encoding="utf-8")
	elif args.context:
		context = args.context
	else:
		for root in (args.docs_repo, args.source_repo):
			candidate = Path(root) / "PROJECT_CONTEXT.md"
			if candidate.is_file():
				context = candidate.read_text(encoding="utf-8")
				break
		else:
			raise SystemExit("No context given: pass --context-file, --context, or add PROJECT_CONTEXT.md to the checkout root")

	project_id = asyncio.run(
		create_project(args.name, args.source_repo, args.docs_repo, context, ensure_existing=args.ensure)
	)
	if args.ensure:
		print(project_id)
	else:
		print(f"Created project ID {project_id} for {args.source_repo}.")


if __name__ == "__main__":
	main()

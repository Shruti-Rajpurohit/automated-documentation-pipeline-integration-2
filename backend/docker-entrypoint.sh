#!/bin/sh
set -eu

export DATABASE_URL=${DATABASE_URL:-"sqlite+aiosqlite:////data/documentation_pipeline.db"}
mkdir -p /data 2>/dev/null || true

# Git refuses bind-mounted checkouts owned by another uid ("dubious
# ownership"); checkouts under REPOSITORY_ROOTS are trusted content here.
for root in $(echo "${REPOSITORY_ROOTS:-/srv/repos}" | tr "," " "); do
  for dir in "$root"/*; do
    [ -d "$dir/.git" ] && git config --global --add safe.directory "$dir" 2>/dev/null || true
  done
done

python -m app.db.provision_user --ensure writer writer@example.com WRITER >/dev/null
python -m app.db.provision_user --ensure reviewer reviewer@example.com REVIEWER >/dev/null
python -m app.db.provision_user --ensure approver approver@example.com APPROVER >/dev/null

echo "pipeline-api: identities provisioned (writer/reviewer/approver)"
exec python -m app.main --host 0.0.0.0 --port "${API_PORT:-8000}"

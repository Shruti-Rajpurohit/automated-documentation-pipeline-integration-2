#!/bin/sh
# Local two-tier development. This script starts the Python tier; run the
# web tier from the repository root with `npm run dev`.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)

: "${API_PORT:=8000}"
export DATABASE_URL=${DATABASE_URL:-"sqlite+aiosqlite:///$ROOT_DIR/backend/data/documentation_pipeline.db"}
export AUTH_PROXY_SECRET=${AUTH_PROXY_SECRET:-"$(openssl rand -hex 32)"}
export REPOSITORY_ROOTS=${REPOSITORY_ROOTS:-"$ROOT_DIR/repos"}

echo "FastAPI: http://127.0.0.1:$API_PORT"
echo "Put this in the web tier .env.local:"
echo "  AUTH_PROXY_SECRET=$AUTH_PROXY_SECRET"
echo "  PIPELINE_BACKEND_URL=http://127.0.0.1:$API_PORT"

cd "$ROOT_DIR/backend"
exec python -m app.main --host 127.0.0.1 --port "$API_PORT" --reload

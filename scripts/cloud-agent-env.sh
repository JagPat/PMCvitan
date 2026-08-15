#!/usr/bin/env bash
# Shared helpers for cloud-agent-install.sh and cloud-agent-start.sh.

DEFAULT_DATABASE_URL='postgresql://vitan:vitan@localhost:5432/vitan_pmc?schema=public'
SEED_PROJECT_ID='ambli'
# Created near the end of apps/api/prisma/seed.ts — absent if seed was interrupted early.
SEED_COMPLETION_MARK='test-drawing-a'

resolve_database_url() {
  export DATABASE_URL="${DATABASE_URL:-$DEFAULT_DATABASE_URL}"
}

# psql/libpq: drop Prisma-only schema=; keep sslmode and other libpq params.
psql_database_url() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

raw = sys.argv[1]
parts = urlsplit(raw)
query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != "schema"]
query_string = urlencode(query)

if parts.netloc:
    out = urlunsplit((parts.scheme, parts.netloc, parts.path, query_string, parts.fragment))
elif parts.scheme in ("postgresql", "postgres") and parts.path.startswith("/"):
    # libpq empty-host form: postgresql:///dbname?host=... (urlunsplit drops the "//").
    out = f"{parts.scheme}:///{parts.path.lstrip('/')}"
    if query_string:
        out += f"?{query_string}"
    if parts.fragment:
        out += f"#{parts.fragment}"
else:
    out = urlunsplit((parts.scheme, parts.netloc, parts.path, query_string, parts.fragment))

print(out)
PY
}

# Prisma schema= query param (libpq uses search_path instead).
prisma_schema_from_url() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import parse_qsl, urlsplit

for key, value in parse_qsl(urlsplit(sys.argv[1]).query, keep_blank_values=True):
    if key == "schema" and value:
        print(value)
        break
PY
}

database_url_log_label() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import urlparse

u = urlparse(sys.argv[1])
host = u.hostname or "?"
port = f":{u.port}" if u.port else ""
db = (u.path or "/").lstrip("/") or "?"
print(f"{host}{port}/{db}")
PY
}

set_env_var() {
  local file="$1" key="$2" value="$3"
  touch "$file"
  python3 - "$file" "$key" "$value" <<'PY'
import pathlib
import re
import sys

path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
text = pathlib.Path(path).read_text(encoding="utf-8") if pathlib.Path(path).exists() else ""
line = f'{key}="{value}"'
pattern = re.compile(rf"^{re.escape(key)}=.*$", re.MULTILINE)
if pattern.search(text):
    text = pattern.sub(line, text)
else:
    if text and not text.endswith("\n"):
        text += "\n"
    text += line + "\n"
pathlib.Path(path).write_text(text, encoding="utf-8")
PY
}

env_var_present() {
  local key="$1" file="$2"
  if [ -n "${!key}" ]; then
    return 0
  fi
  [ -f "$file" ] && grep -q "^${key}=" "$file"
}

ensure_api_env_database() {
  resolve_database_url
  touch apps/api/.env
  set_env_var apps/api/.env DATABASE_URL "$DATABASE_URL"
}

ensure_api_env() {
  ensure_api_env_database
  if [ "$DATABASE_URL" = "$DEFAULT_DATABASE_URL" ]; then
    set_env_var apps/api/.env JWT_SECRET "dev-secret-change-in-prod"
    set_env_var apps/api/.env ALLOW_DEV_AUTH "true"
    set_env_var apps/api/.env CORS_ORIGINS ""
    return 0
  fi
  if ! env_var_present JWT_SECRET apps/api/.env; then
    echo "[cloud-agent-env] External DATABASE_URL requires JWT_SECRET (environment or apps/api/.env)" >&2
    exit 1
  fi
}

# psql helper: honour Prisma schema= via search_path (libpq URLs omit schema=).
psql_tc() {
  local sql="$1"
  local schema="${2:-}"
  if [ -n "$schema" ]; then
    psql "$PSQL_URL" -v ON_ERROR_STOP=1 -tc "SET search_path TO \"${schema}\"; ${sql}"
  else
    psql "$PSQL_URL" -tc "$sql"
  fi
}

seed_permitted() {
  resolve_database_url
  if [ "$DATABASE_URL" = "$DEFAULT_DATABASE_URL" ]; then
    return 0
  fi
  case "${CLOUD_AGENT_ALLOW_SEED:-}" in
    1 | true | TRUE | yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

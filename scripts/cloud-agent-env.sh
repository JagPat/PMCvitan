#!/usr/bin/env bash
# Shared helpers for cloud-agent-install.sh and cloud-agent-start.sh.

DEFAULT_DATABASE_URL='postgresql://vitan:vitan@localhost:5432/vitan_pmc?schema=public'
SEED_PROJECT_ID='ambli'

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
print(urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)))
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

ensure_api_env() {
  resolve_database_url
  touch apps/api/.env
  set_env_var apps/api/.env DATABASE_URL "$DATABASE_URL"
  set_env_var apps/api/.env JWT_SECRET "dev-secret-change-in-prod"
  set_env_var apps/api/.env ALLOW_DEV_AUTH "true"
  set_env_var apps/api/.env CORS_ORIGINS ""
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

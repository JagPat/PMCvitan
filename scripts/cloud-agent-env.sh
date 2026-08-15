#!/usr/bin/env bash
# Shared helpers for cloud-agent-install.sh and cloud-agent-start.sh.

DEFAULT_DATABASE_URL='postgresql://vitan:vitan@localhost:5432/vitan_pmc?schema=public'
DEV_JWT_SECRET='dev-secret-change-in-prod'
# Public placeholders that must never sign tokens against an external database.
PLACEHOLDER_JWT_SECRETS='dev-secret-change-in-prod
change-me
change-me-too'
SEED_PROJECT_ID='ambli'
# Written last in apps/api/prisma/seed.ts as an AuditLog row (not a user-facing notice).
SEED_COMPLETION_MARK='cloud-agent-seed-complete'
# Prisma connector args that libpq/psql reject (keep sslmode, host, etc.).
PRISMA_ONLY_QUERY_KEYS='schema connection_limit pool_timeout pgbouncer statement_cache_size socket_timeout sslidentity sslpassword sslaccept max_idle_connection_lifetime'

resolve_database_url() {
  export DATABASE_URL="${DATABASE_URL:-$DEFAULT_DATABASE_URL}"
}

# psql/libpq: drop Prisma-only query args; keep sslmode and other libpq params.
psql_database_url() {
  python3 - "$1" $PRISMA_ONLY_QUERY_KEYS <<'PY'
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

raw = sys.argv[1]
drop = {key.lower() for key in sys.argv[2:]}
parts = urlsplit(raw)
query = [
    (k, v)
    for k, v in parse_qsl(parts.query, keep_blank_values=True)
    if k.lower() not in drop
]
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

unset_env_var() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  python3 - "$file" "$key" <<'PY'
import pathlib
import re
import sys

path, key = sys.argv[1], sys.argv[2]
text = pathlib.Path(path).read_text(encoding="utf-8")
pattern = re.compile(rf"^{re.escape(key)}=.*\n?", re.MULTILINE)
pathlib.Path(path).write_text(pattern.sub("", text), encoding="utf-8")
PY
}

read_env_var() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  python3 - "$file" "$key" <<'PY'
import pathlib
import re
import sys

path, key = sys.argv[1], sys.argv[2]
text = pathlib.Path(path).read_text(encoding="utf-8")
match = re.search(rf"^{re.escape(key)}=(.*)$", text, re.MULTILINE)
if not match:
    raise SystemExit(0)
value = match.group(1).strip()
if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
    value = value[1:-1]
print(value)
PY
}

jwt_is_generated() {
  local value="${1:-}"
  [ -n "$value" ] || return 1
  printf '%s\n' "$PLACEHOLDER_JWT_SECRETS" | grep -Fxq -- "$value"
}

external_jwt_supplied() {
  if [ -n "${JWT_SECRET:-}" ] && ! jwt_is_generated "$JWT_SECRET"; then
    return 0
  fi
  local file_jwt
  file_jwt="$(read_env_var apps/api/.env JWT_SECRET || true)"
  [ -n "$file_jwt" ] && ! jwt_is_generated "$file_jwt"
}

ensure_api_env_database() {
  resolve_database_url
  touch apps/api/.env
  set_env_var apps/api/.env DATABASE_URL "$DATABASE_URL"
}

ensure_api_env() {
  ensure_api_env_database
  if [ "$DATABASE_URL" = "$DEFAULT_DATABASE_URL" ]; then
    set_env_var apps/api/.env JWT_SECRET "$DEV_JWT_SECRET"
    set_env_var apps/api/.env ALLOW_DEV_AUTH "true"
    set_env_var apps/api/.env CORS_ORIGINS ""
    return 0
  fi
  # Local→external: generated JWT / ALLOW_DEV_AUTH must not count as operator secrets.
  if jwt_is_generated "${JWT_SECRET:-}"; then
    unset JWT_SECRET
  fi
  local file_jwt
  file_jwt="$(read_env_var apps/api/.env JWT_SECRET || true)"
  if jwt_is_generated "$file_jwt"; then
    unset_env_var apps/api/.env JWT_SECRET
  fi
  if [ -z "${ALLOW_DEV_AUTH:-}" ]; then
    unset_env_var apps/api/.env ALLOW_DEV_AUTH
    unset ALLOW_DEV_AUTH || true
  fi
  if ! external_jwt_supplied; then
    echo "[cloud-agent-env] External DATABASE_URL requires JWT_SECRET (environment or apps/api/.env); generated local-dev secrets are not accepted" >&2
    exit 1
  fi
}

ensure_web_env() {
  resolve_database_url
  local dev_auth='false'
  if [ "$DATABASE_URL" = "$DEFAULT_DATABASE_URL" ] || [ "${ALLOW_DEV_AUTH:-}" = 'true' ]; then
    dev_auth='true'
  fi
  touch apps/web/.env
  set_env_var apps/web/.env VITE_API_URL 'http://localhost:3000'
  set_env_var apps/web/.env VITE_ALLOW_DEV_AUTH "$dev_auth"
}

# After sourcing .env and restoring inherited secrets: pin listen port and
# fail-closed OTP stubs on an external database unless explicitly opted in.
# declare -g: these run from apply_api_env_defaults, where `declare -x` (export -p)
# would otherwise restore bindings as function-locals that vanish on return.
pin_api_runtime_env() {
  declare -gx PORT=3000
  resolve_database_url
  if [ "$DATABASE_URL" = "$DEFAULT_DATABASE_URL" ]; then
    return 0
  fi
  case "${CLOUD_AGENT_ALLOW_AUTH_STUBS:-}" in
    1 | true | TRUE | yes | YES) return 0 ;;
  esac
  declare -gx NODE_ENV=production
}

apply_api_env_defaults() {
  local -a _pre=()
  mapfile -t _pre < <(export -p)
  set -a
  if [ -f apps/api/.env ]; then
    # shellcheck disable=SC1091
    source apps/api/.env
  fi
  set +a
  local _line
  for _line in "${_pre[@]}"; do
    eval "${_line/declare -x/declare -gx}"
  done
  pin_api_runtime_env
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

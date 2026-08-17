#!/usr/bin/env bash

CLOUD_AGENT_DATABASE_URL='postgresql://vitan:vitan@localhost:5432/vitan_pmc?schema=public'
CLOUD_AGENT_JWT_SECRET='dev-secret-change-in-prod'

# Debian/Ubuntu keep the server binary off PATH as /usr/lib/postgresql/*/bin/postgres.
# Client packages still provide psql and pg_isready, so those two commands are not
# evidence that a server can be started.
cloud_agent_has_postgres_server() {
  command -v pg_ctlcluster >/dev/null 2>&1 && return 0
  command -v postgres >/dev/null 2>&1 && return 0
  local candidate
  local glob="${CLOUD_AGENT_POSTGRES_LIB_GLOB:-/usr/lib/postgresql/*/bin/postgres}"
  # shellcheck disable=SC2086
  for candidate in $glob; do
    if [[ -x "$candidate" ]]; then
      return 0
    fi
  done
  return 1
}

cloud_agent_needs_postgres_packages() {
  if ! command -v psql >/dev/null 2>&1; then
    return 0
  fi
  if ! command -v pg_isready >/dev/null 2>&1; then
    return 0
  fi
  if ! cloud_agent_has_postgres_server; then
    return 0
  fi
  return 1
}

pin_cloud_agent_api_env() {
  export DATABASE_URL="$CLOUD_AGENT_DATABASE_URL"
  export JWT_SECRET="$CLOUD_AGENT_JWT_SECRET"
  export ALLOW_DEV_AUTH='true'
  export NODE_ENV='development'
  export PORT='3000'
  export CORS_ORIGINS=''
  unset \
    S3_ENDPOINT \
    S3_BUCKET \
    S3_ACCESS_KEY_ID \
    S3_SECRET_ACCESS_KEY \
    S3_REGION \
    S3_PUBLIC_BASE \
    SMTP_HOST \
    SMTP_PORT \
    SMTP_SECURE \
    SMTP_USER \
    SMTP_PASS \
    SMTP_FROM \
    MSG91_AUTH_KEY \
    MSG91_TEMPLATE_ID \
    MSG91_SENDER_ID \
    FAST2SMS_API_KEY \
    FAST2SMS_OTP_ID \
    TELEGRAM_GATEWAY_TOKEN \
    VAPID_PUBLIC_KEY \
    VAPID_PRIVATE_KEY \
    VAPID_SUBJECT \
    GOOGLE_CLIENT_ID \
    WORKER_ENROLL_SECRET \
    AWS_ACCESS_KEY_ID \
    AWS_SECRET_ACCESS_KEY \
    AWS_SESSION_TOKEN \
    AWS_REGION \
    OUTBOX_SENDER_MODE
}

pin_cloud_agent_web_env() {
  export VITE_API_URL='http://localhost:3000'
  export VITE_ALLOW_DEV_AUTH='true'
}

#!/usr/bin/env bash

CLOUD_AGENT_DATABASE_URL='postgresql://vitan:vitan@localhost:5432/vitan_pmc?schema=public'
CLOUD_AGENT_JWT_SECRET='dev-secret-change-in-prod'

pin_cloud_agent_api_env() {
  export DATABASE_URL="$CLOUD_AGENT_DATABASE_URL"
  export JWT_SECRET="$CLOUD_AGENT_JWT_SECRET"
  export ALLOW_DEV_AUTH='true'
  export NODE_ENV='development'
  export PORT='3000'
  export CORS_ORIGINS=''
}

pin_cloud_agent_web_env() {
  export VITE_API_URL='http://localhost:3000'
  export VITE_ALLOW_DEV_AUTH='true'
}

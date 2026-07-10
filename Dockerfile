# Vitan PMC — web app container (build with pnpm, serve the static SPA with nginx).
# Built from the repo root because apps/web consumes packages/shared.
# Deploy target: Coolify (Build Pack = Dockerfile). See docs/DEPLOY.md.

# ---- build stage ----
FROM node:22-alpine AS build
RUN npm install -g pnpm@10.33.0
WORKDIR /app
# Every VITE_* value is baked into the static bundle at build time — Coolify must
# pass them as BUILD variables (not runtime env, which the finished bundle ignores).
# DEP-03: all three the web app reads are declared here so a production build can't
# silently ship without its auth configuration.
#   VITE_API_URL          API origin; unset = the seeded local demo store
#   VITE_GOOGLE_CLIENT_ID Google Identity Services client id (empty = no Google button)
#   VITE_ALLOW_DEV_AUTH   "true" enables the passwordless persona switch — DEV ONLY
ARG VITE_API_URL=""
ARG VITE_GOOGLE_CLIENT_ID=""
ARG VITE_ALLOW_DEV_AUTH=""
ENV VITE_API_URL=$VITE_API_URL \
    VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID \
    VITE_ALLOW_DEV_AUTH=$VITE_ALLOW_DEV_AUTH
COPY . .
RUN pnpm install --frozen-lockfile
# Misconfiguration guards: an API-connected build without Google sign-in is almost
# always a forgotten build variable (the button silently disappears), and dev-auth
# in an API-connected build reopens the passwordless persona switch.
RUN if [ -n "$VITE_API_URL" ] && [ -z "$VITE_GOOGLE_CLIENT_ID" ]; then \
      echo "WARNING: VITE_API_URL is set but VITE_GOOGLE_CLIENT_ID is empty — Google sign-in will be MISSING from this build"; fi \
 && if [ -n "$VITE_API_URL" ] && [ "$VITE_ALLOW_DEV_AUTH" = "true" ]; then \
      echo "ERROR: VITE_ALLOW_DEV_AUTH=true in an API-connected build — refusing to bake dev auth into production" && exit 1; fi
RUN pnpm --filter web build

# ---- serve stage ----
FROM nginx:1.27-alpine AS serve
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]

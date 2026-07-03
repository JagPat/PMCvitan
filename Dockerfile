# Vitan PMC — web app container (build with pnpm, serve the static SPA with nginx).
# Built from the repo root because apps/web consumes packages/shared.
# Deploy target: Coolify (Build Pack = Dockerfile). See docs/DEPLOY.md.

# ---- build stage ----
FROM node:22-alpine AS build
RUN npm install -g pnpm@10.33.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter web build

# ---- serve stage ----
FROM nginx:1.27-alpine AS serve
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]

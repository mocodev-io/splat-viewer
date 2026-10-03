# --- build: Vite bundles the React app into dist/
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
RUN npm run typecheck && npm run build

# --- runtime: static files served by nginx
FROM nginx:stable-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
RUN mkdir -p /splats /settings && chown nginx:nginx /settings

# mount your splats here, read-only is fine; settings are saved into
# /settings, so that one must be writable for the nginx user (uid 101)
VOLUME ["/splats", "/settings"]

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO /dev/null http://127.0.0.1/ || exit 1

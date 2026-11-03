# Edge = nginx serving the SPA, load-balancing the API and caching HLS.
# Build context: repository root.
FROM node:24-trixie-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM nginx:1.30-alpine
ENV DNS_RESOLVER=127.0.0.11 \
    API_HOST=api API_PORT=3000 \
    S3_HOST=seaweedfs S3_PORT=8333 S3_BUCKET=hls \
    HLS_CACHE_MAX_SIZE=2g
COPY deploy/edge/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=web /web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/edge-health >/dev/null || exit 1

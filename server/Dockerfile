# StreamHub server image. Two targets share one codebase:
#   api    — HTTP API, SSE, control plane (leader-elected)
#   worker — transcoder (adds static FFmpeg 9)
# Node 24 runs the TypeScript sources directly (type stripping), no build step.
FROM mwader/static-ffmpeg:9.0.2-1 AS ffmpeg

FROM node:24-trixie-slim AS base
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY tsconfig.json ./
COPY migrations ./migrations
COPY src ./src
USER node

FROM base AS api
ENV SERVICE_NAME=api
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/api/main.ts"]

FROM base AS worker
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
ENV SERVICE_NAME=worker
EXPOSE 9100
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9100/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/worker/main.ts"]

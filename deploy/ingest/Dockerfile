# Ingest node: MediaMTX + tiny glue scripts (auth via the control plane,
# lifecycle hooks, self-registration heartbeat). The upstream image is
# FROM scratch, so we add a minimal Alpine userland for curl/sh.
FROM bluenviron/mediamtx:1.21.3 AS mediamtx

FROM alpine:3.24
RUN apk add --no-cache curl ca-certificates tini
COPY --from=mediamtx /mediamtx /usr/local/bin/mediamtx
COPY mediamtx.yml /etc/mediamtx/mediamtx.yml
COPY --chmod=0755 entrypoint.sh notify.sh /usr/local/bin/
# RTMP, RTMPS, SRT(udp), WebRTC/WHIP http, WebRTC media(udp), RTSP (internal), API, metrics
EXPOSE 1935 1936 8890/udp 8889 8189/udp 8554 9997 9998
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD curl -fsS -o /dev/null http://127.0.0.1:9997/v3/paths/list || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]

#!/bin/sh
# Wires a MediaMTX node into the StreamHub control plane.
set -eu

: "${CONTROL_URL:=http://api:3000}"
: "${INTERNAL_SECRET:?INTERNAL_SECRET is required}"
: "${NODE_ID:=$(hostname)}"
NODE_IP="$(hostname -i | awk '{print $1}')"
# URLs the control plane / transcoders use to reach THIS node (internal network).
: "${NODE_API_URL:=http://${NODE_IP}:9997}"
: "${NODE_RTSP_URL:=rtsp://${NODE_IP}:8554}"
: "${NODE_SRT_URL:=srt://${NODE_IP}:8890}"
export NODE_ID CONTROL_URL INTERNAL_SECRET

# Every publish/read is authorised by the control plane. The secret travels as
# URL userinfo, which Go's HTTP client sends as a Basic Authorization header
# (never in the request line / access logs).
CONTROL_SCHEME="${CONTROL_URL%%://*}"
CONTROL_HOSTPATH="${CONTROL_URL#*://}"
export MTX_AUTHHTTPADDRESS="${CONTROL_SCHEME}://mediamtx:${INTERNAL_SECRET}@${CONTROL_HOSTPATH}/internal/mediamtx/auth"

# Self-registration heartbeat: lets the control plane discover, reconcile and
# detect the death of ingest nodes without static configuration.
(
  while true; do
    curl -fsS -m 3 -o /dev/null -X POST -H 'content-type: application/json' \
      -H "Authorization: Bearer ${INTERNAL_SECRET}" \
      -d "{\"node\":\"${NODE_ID}\",\"apiUrl\":\"${NODE_API_URL}\",\"rtspUrl\":\"${NODE_RTSP_URL}\",\"srtUrl\":\"${NODE_SRT_URL}\"}" \
      "${CONTROL_URL}/internal/ingest/heartbeat" \
      || echo "[ingest] heartbeat to control plane failed" >&2
    sleep 5
  done
) &

exec /usr/local/bin/mediamtx /etc/mediamtx/mediamtx.yml

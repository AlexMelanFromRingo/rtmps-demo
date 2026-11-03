#!/usr/bin/env bash
# Publish a synthetic test stream (no OBS needed), using FFmpeg 9 in Docker.
#
#   scripts/demo-stream.sh <stream_key> [codec] [protocol] [resolution] [fps]
#     codec:    h264 | hevc | av1 | vp9           (default h264)
#     protocol: rtmp | srt | whip                 (default rtmp)
#     e.g. scripts/demo-stream.sh live_xxx av1 rtmp 1920x1080 60
#
# Env: INGEST_HOST (default 127.0.0.1), DURATION seconds (default 3600).
set -euo pipefail

KEY="${1:?usage: $0 <stream_key> [h264|hevc|av1|vp9] [rtmp|srt|whip] [WxH] [fps]}"
CODEC="${2:-h264}"
PROTO="${3:-rtmp}"
SIZE="${4:-1280x720}"
FPS="${5:-30}"
HOST="${INGEST_HOST:-127.0.0.1}"
DURATION="${DURATION:-3600}"
GOP=$((FPS * 2))

case "$CODEC" in
  h264) V=(-c:v libx264 -preset veryfast -tune zerolatency -b:v 4M -g "$GOP" -pix_fmt yuv420p) ;;
  hevc) V=(-c:v libx265 -preset ultrafast -x265-params log-level=error -b:v 3M -g "$GOP" -pix_fmt yuv420p) ;;
  av1)  V=(-c:v libsvtav1 -preset 12 -b:v 3M -g "$GOP" -pix_fmt yuv420p) ;;
  vp9)  V=(-c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 3M -g "$GOP") ;;
  *) echo "unknown codec $CODEC" >&2; exit 1 ;;
esac

NET=(--network host)
case "$PROTO" in
  rtmp) A=(-c:a aac -b:a 128k); OUT=(-f flv "rtmp://$HOST:1935/live/$KEY") ;;
  srt)  A=(-c:a aac -b:a 128k); OUT=(-f mpegts "srt://$HOST:8890?streamid=publish:live/$KEY&pkt_size=1316") ;;
  whip)
    [ "$CODEC" = h264 ] || { echo "FFmpeg's WHIP muxer supports H.264 only; use the browser publisher for AV1/VP9" >&2; exit 1; }
    V=(-c:v libx264 -preset veryfast -tune zerolatency -bf 0 -b:v 3M -g "$GOP" -profile:v baseline -pix_fmt yuv420p)
    A=(-c:a libopus -ar 48000 -ac 2)
    # WHIP ICE candidate is the container address: publish from inside the ingest netns.
    NET=(--network "container:${INGEST_CONTAINER:-streamhub-ingest-1}")
    OUT=(-handshake_timeout 20000 -f whip "http://127.0.0.1:8889/live/$KEY/whip") ;;
  *) echo "unknown protocol $PROTO" >&2; exit 1 ;;
esac

NAME="streamhub-demo-${KEY: -6}"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" "${NET[@]}" mwader/static-ffmpeg:9.0.2-1 \
  -hide_banner -loglevel error -re \
  -f lavfi -i "testsrc2=size=$SIZE:rate=$FPS" \
  -f lavfi -i "sine=frequency=330:beep_factor=4:sample_rate=48000" \
  "${V[@]}" "${A[@]}" -t "$DURATION" "${OUT[@]}" >/dev/null
echo "publishing $CODEC $SIZE@$FPS over $PROTO (container $NAME). Stop: docker rm -f $NAME"

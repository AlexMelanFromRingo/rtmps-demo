#!/bin/sh
# MediaMTX hook → control plane. Usage: notify.sh online|offline
# MediaMTX provides MTX_PATH, MTX_SOURCE_TYPE, MTX_SOURCE_ID.
# Retries cover short control-plane outages; the reconciler covers the rest.
exec curl -fsS -m 5 --retry 6 --retry-delay 1 --retry-all-errors -o /dev/null -X POST \
  -H 'content-type: application/json' -H "Authorization: Bearer ${INTERNAL_SECRET}" \
  -d "{\"node\":\"${NODE_ID}\",\"path\":\"${MTX_PATH}\",\"sourceType\":\"${MTX_SOURCE_TYPE:-}\",\"sourceId\":\"${MTX_SOURCE_ID:-}\"}" \
  "${CONTROL_URL}/internal/ingest/$1"

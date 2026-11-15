#!/usr/bin/env bash
# Smoke test of the Phase 03 video pipeline against the running Compose stack,
# from the HOST (like a real client): register → confirm (Mailpit) → login →
# POST /videos (draft) → PUT parts straight to MinIO via presigned URLs →
# complete → the `video-worker` CONTAINER processes it → ready → stream (206)
# and download (attachment).
#
# Requires: the stack up (`docker compose up -d`), migrations applied and the
# API dev server running (`docker compose exec -d nestjs-api npm run start:dev`).
# Host tools: curl, jq, dd, cmp, stat. Parts and the download are streamed
# (no copies on disk), so a 10 GiB file needs no extra space.
#
# Usage: scripts/smoke-video-pipeline.sh [video-file]
#   default file: test/fixtures/sample.mp4. Any file larger than 64 MiB is sent
#   in several parts (e.g. a 200 MiB file → 4 parts).
# Env: API_URL (http://localhost:3000), MAILPIT_URL (http://localhost:8025),
#      TIMEOUT_SECONDS (180).
set -euo pipefail

cd "$(dirname "$0")/.."
FILE="${1:-test/fixtures/sample.mp4}"
API_URL="${API_URL:-http://localhost:3000}"
MAILPIT_URL="${MAILPIT_URL:-http://localhost:8025}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-180}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

step() { printf '\n==> %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
json() { curl -sS --fail-with-body -H 'Content-Type: application/json' "$@"; }

[ -f "$FILE" ] || fail "file not found: $FILE"
SIZE=$(stat -c %s "$FILE")
NAME=$(basename "$FILE")
EMAIL="smoke_$(date +%s)_$RANDOM@example.com"
PASSWORD='smoke-password-123'

step "Register $EMAIL"
json -X POST "$API_URL/auth/register" -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null

step "Confirm the account with the token from Mailpit"
TOKEN=""
for _ in $(seq 1 20); do
  ID=$(curl -sS "$MAILPIT_URL/api/v1/search?query=to:$EMAIL" | jq -r '.messages[0].ID // empty')
  if [ -n "$ID" ]; then
    TOKEN=$(curl -sS "$MAILPIT_URL/api/v1/message/$ID" | jq -r '.Text' | grep -o 'token=[A-Za-z0-9_-]*' | head -1 | cut -d= -f2)
    break
  fi
  sleep 1
done
[ -n "$TOKEN" ] || fail "confirmation e-mail not found in Mailpit ($MAILPIT_URL)"
curl -sS --fail -o /dev/null "$API_URL/auth/confirm-email?token=$TOKEN"

step "Login"
ACCESS=$(json -X POST "$API_URL/auth/login" -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jq -r .access_token)
AUTH="Authorization: Bearer $ACCESS"

step "POST /videos — pre-register as draft ($NAME, $SIZE bytes)"
CREATED=$(json -X POST "$API_URL/videos" -H "$AUTH" \
  -d "{\"title\":\"Smoke $NAME\",\"file_name\":\"$NAME\",\"file_size\":$SIZE,\"content_type\":\"video/mp4\"}")
echo "$CREATED" | jq .
SLUG=$(echo "$CREATED" | jq -r .slug)
PART_SIZE=$(echo "$CREATED" | jq -r .upload.part_size)
PART_COUNT=$(echo "$CREATED" | jq -r .upload.part_count)
[ "$(echo "$CREATED" | jq -r .status)" = draft ] || fail "video is not draft"

step "Upload $PART_COUNT part(s) of $PART_SIZE bytes directly to the object storage"
PARTS='[]'
for ((start = 1; start <= PART_COUNT; start += 100)); do
  end=$((start + 99 < PART_COUNT ? start + 99 : PART_COUNT))
  NUMBERS=$(seq -s, "$start" "$end")
  URLS=$(json -X POST "$API_URL/videos/$SLUG/upload/part-urls" -H "$AUTH" -d "{\"part_numbers\":[$NUMBERS]}")
  for n in $(seq "$start" "$end"); do
    URL=$(echo "$URLS" | jq -r ".urls[] | select(.part_number == $n) | .url")
    ETAG=$(dd if="$FILE" iflag=skip_bytes,count_bytes skip=$(((n - 1) * PART_SIZE)) \
        count="$PART_SIZE" bs=4M status=none \
      | curl -sS --fail -X PUT -H 'Content-Type:' --data-binary @- -D - -o /dev/null "$URL" \
      | grep -i '^etag:' | cut -d' ' -f2 | tr -d '\r')
    echo "  part $n → $(echo "$URL" | cut -d'?' -f1) etag=$ETAG"
    PARTS=$(echo "$PARTS" | jq -c --argjson n "$n" --arg e "$ETAG" '. + [{part_number: $n, etag: $e}]')
  done
done
json "$API_URL/videos/$SLUG/upload/parts" -H "$AUTH" | jq -c '.parts | length' | xargs echo "  parts stored:"

step "POST /videos/$SLUG/upload/complete"
json -X POST "$API_URL/videos/$SLUG/upload/complete" -H "$AUTH" -d "{\"parts\":$PARTS}" | jq -c .

step "Wait for the video-worker container to process it"
DEADLINE=$((SECONDS + TIMEOUT_SECONDS))
while :; do
  VIDEO=$(json "$API_URL/videos/$SLUG" -H "$AUTH")
  STATUS=$(echo "$VIDEO" | jq -r .status)
  echo "  status: $STATUS"
  [ "$STATUS" = ready ] && break
  [ "$STATUS" = failed ] && fail "processing failed: $(echo "$VIDEO" | jq -r .processing_error)"
  [ $SECONDS -lt $DEADLINE ] || fail "timed out waiting for ready"
  sleep 2
done
echo "$VIDEO" | jq '{slug, status, duration_seconds, metadata, size_bytes, thumbnail: (.thumbnail_url | split("?")[0])}'
THUMB_TYPE=$(curl -sS -o /dev/null -w '%{content_type}' "$(echo "$VIDEO" | jq -r .thumbnail_url)")
echo "  thumbnail content-type: $THUMB_TYPE"
[ "$THUMB_TYPE" = image/jpeg ] || fail "thumbnail is not a JPEG"

step "GET /videos/$SLUG/stream → 302 → Range request on the storage"
STREAM_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H "$AUTH" "$API_URL/videos/$SLUG/stream")
RANGE=$(curl -sS -L -o /dev/null -w '%{http_code} %{size_download}' -r 0-1023 -H "$AUTH" "$API_URL/videos/$SLUG/stream")
echo "  API: $STREAM_CODE · storage with Range 0-1023: $RANGE"
[ "$STREAM_CODE" = 302 ] && [ "$RANGE" = "206 1024" ] || fail "streaming check failed"

step "GET /videos/$SLUG/download → 302 → attachment"
curl -sS -L -D "$WORK/headers" -H "$AUTH" "$API_URL/videos/$SLUG/download" | cmp -s - "$FILE" \
  && echo "  downloaded file is identical to the upload" || fail "downloaded file differs"
DISPOSITION=$(grep -i '^content-disposition:' "$WORK/headers" | tr -d '\r')
echo "  $DISPOSITION"
echo "$DISPOSITION" | grep -q 'attachment' || fail "download is not an attachment"

printf '\nSMOKE OK — video %s processed by the video-worker container\n' "$SLUG"

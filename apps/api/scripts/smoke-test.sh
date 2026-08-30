#!/usr/bin/env bash
#
# Post-deploy smoke test (TICK-20).
#
#   ./scripts/smoke-test.sh https://api.example.com          # read-only
#   ./scripts/smoke-test.sh https://api.example.com --full   # + writes data
#
# Exits 0 when every check passes, 1 on the first failure, so it can gate a
# deploy step rather than be something a human squints at.
#
# The default run is READ-ONLY and safe against production: it proves the
# process is up, the schema matches, configuration that is easy to get wrong
# (CORS, correlation IDs) is right, and the error mapping works. It does not
# prove a purchase works end to end.
#
# `--full` does, by buying a seat and refunding it — which CREATES REAL ROWS,
# including ledger entries that are append-only by design. That is the right
# trade in staging and a deliberate decision in production, so it is opt-in
# rather than the default.
#
# Needs curl and jq on PATH. Not shipped in the runtime image: it runs from CI
# or a laptop, against a deployment.

set -euo pipefail

BASE_URL="${1:-}"
MODE="${2:-}"

if [ -z "$BASE_URL" ]; then
  echo "usage: $0 <base-url> [--full]" >&2
  exit 2
fi
BASE_URL="${BASE_URL%/}"

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required" >&2; exit 2; }
done

PASSED=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n         %s\n' "$1" "${2:-}" >&2; exit 1; }

# Portable: GNU date wants -d, BSD/macOS date wants -r.
iso_at() {
  local at=$(( $(date +%s) + $1 ))
  date -u -d "@$at" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$at" +%Y-%m-%dT%H:%M:%SZ
}

uuid() {
  if command -v uuidgen >/dev/null 2>&1; then uuidgen | tr '[:upper:]' '[:lower:]'
  elif [ -r /proc/sys/kernel/random/uuid ]; then cat /proc/sys/kernel/random/uuid
  else python3 -c 'import uuid; print(uuid.uuid4())'
  fi
}

# Writes the body to $BODY and returns the status code.
BODY=$(mktemp); trap 'rm -f "$BODY"' EXIT
call() {
  local method=$1 path=$2 payload=${3:-}
  # Only the fixed three are consumed; whatever is left is passed to curl as
  # extra headers. `shift 3` would fail outright on a two-argument call.
  shift $(( $# < 3 ? $# : 3 ))
  if [ -n "$payload" ]; then
    curl -sS -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path" \
      -H 'content-type: application/json' "$@" -d "$payload"
  else
    curl -sS -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path" "$@"
  fi
}

echo
echo "Smoke test → $BASE_URL"
echo

# ---- 1. Liveness ------------------------------------------------------------
# Is the process up at all? Nothing external is touched, so a failure here is
# the process, not its dependencies.
code=$(call GET /healthz)
[ "$code" = "200" ] || fail "liveness /healthz" "expected 200, got $code"
pass "liveness /healthz is 200"

# ---- 2. Readiness -----------------------------------------------------------
# The one check that gates traffic: Postgres reachable AND the schema matching
# the migrations this build ships. A 503 naming pending versions means the
# migration step has not run — that is a deploy-order problem, not a bad build.
code=$(call GET /readyz)
if [ "$code" != "200" ]; then
  pending=$(jq -r '.details.migrations.pending // [] | join(", ")' "$BODY" 2>/dev/null || echo '')
  [ -n "$pending" ] \
    && fail "readiness /readyz" "503 — migrations pending: $pending. Run the migration step."
  fail "readiness /readyz" "expected 200, got $code: $(head -c 300 "$BODY")"
fi
jq -e '.info.database.status == "up" and .info.migrations.status == "up"' "$BODY" >/dev/null \
  || fail "readiness detail" "$(head -c 300 "$BODY")"
pass "readiness /readyz is 200, database and schema both up"

# ---- 3. Correlation ID ------------------------------------------------------
# Every response must carry one back, so a report can be traced to its log
# lines. A caller-supplied id has to survive rather than be replaced.
mine=$(uuid)
echoed=$(curl -sS -D - -o /dev/null "$BASE_URL/healthz" -H "x-correlation-id: $mine" \
  | tr -d '\r' | awk 'tolower($1) == "x-correlation-id:" { print $2 }')
[ "$echoed" = "$mine" ] || fail "correlation id" "sent $mine, got back '${echoed:-<none>}'"
pass "correlation id is echoed back unchanged"

# ---- 4. CORS ----------------------------------------------------------------
# CORS_ORIGIN is per-environment and a classic thing to ship pointing at
# localhost. Only warns: a deployment with no browser client is legitimate.
allowed=$(curl -sS -D - -o /dev/null -X OPTIONS "$BASE_URL/events" \
  -H 'Origin: https://smoke-test.invalid' -H 'Access-Control-Request-Method: POST' \
  | tr -d '\r' | awk 'tolower($1) == "access-control-allow-origin:" { print $2 }')
if [ -n "$allowed" ]; then
  printf '  \033[33mNOTE\033[0m  CORS allows %s — confirm that is this environment\n' "$allowed"
else
  pass "CORS rejects an unknown origin"
fi

# ---- 5. Error mapping -------------------------------------------------------
# Read-only proof that validation and domain errors still map to status codes:
# a 500 here would mean the filters are not wired up in this build.
code=$(call GET "/events/$(uuid)")
[ "$code" = "404" ] || fail "unknown event" "expected 404, got $code"
pass "unknown event is 404"

code=$(call GET /events/not-a-uuid)
[ "$code" = "400" ] || fail "malformed id" "expected 400, got $code"
pass "malformed id is 400"

if [ "$MODE" != "--full" ]; then
  echo
  echo "$PASSED read-only checks passed. Re-run with --full to exercise a purchase."
  echo
  exit 0
fi

# ---- 6. The purchase journey (writes data) ----------------------------------
echo
printf '  \033[33mNOTE\033[0m  --full: the checks below CREATE REAL DATA\n'

code=$(call POST /events "$(jq -nc \
  --arg name "Smoke test $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg open "$(iso_at -3600)" --arg close "$(iso_at 2592000)" --arg starts "$(iso_at 2678400)" \
  '{name: $name, salesOpenAt: $open, salesCloseAt: $close, startsAt: $starts,
    seatMap: {rows: 1, seatsPerRow: 4}, priceMinor: 5000, currency: "GBP"}')")
[ "$code" = "201" ] || fail "create event" "expected 201, got $code: $(head -c 300 "$BODY")"
EVENT_ID=$(jq -r '.id' "$BODY")
pass "created event $EVENT_ID"

code=$(call GET "/events/$EVENT_ID/seats?status=AVAILABLE&limit=2")
[ "$code" = "200" ] || fail "list seats" "expected 200, got $code"
SEATS=$(jq -c '[.seats[].id]' "$BODY")
[ "$(jq 'length' <<<"$SEATS")" = "2" ] || fail "list seats" "expected 2 seats, got $SEATS"
pass "seat inventory was generated"

code=$(call POST /reservations "$(jq -nc --arg e "$EVENT_ID" --arg h "$(uuid)" --argjson s "$SEATS" \
  '{eventId: $e, holderId: $h, seatIds: $s}')")
[ "$code" = "201" ] || fail "hold seats" "expected 201, got $code: $(head -c 300 "$BODY")"
RESERVATION_ID=$(jq -r '.id' "$BODY")
pass "held two seats (reservation $RESERVATION_ID)"

# The key is required, and replaying it must return the FIRST order rather than
# charging twice — the single most important behaviour on this path.
KEY=$(uuid)
PAY='{"amountMinor":10000,"currency":"GBP"}'
code=$(call POST "/reservations/$RESERVATION_ID/pay" "$PAY" -H "Idempotency-Key: $KEY")
[ "$code" = "200" ] || fail "pay" "expected 200, got $code: $(head -c 300 "$BODY")"
ORDER_ID=$(jq -r '.orderId' "$BODY")
pass "paid — order $ORDER_ID"

code=$(call POST "/reservations/$RESERVATION_ID/pay" "$PAY" -H "Idempotency-Key: $KEY")
replayed=$(jq -r '.orderId' "$BODY")
[ "$code" = "200" ] && [ "$replayed" = "$ORDER_ID" ] \
  || fail "idempotent replay" "expected 200 and order $ORDER_ID, got $code and $replayed"
pass "replaying the payment key returns the same order, not a second charge"

code=$(call POST "/orders/$ORDER_ID/refund" '' -H "Idempotency-Key: $(uuid)")
[ "$code" = "200" ] || fail "refund" "expected 200, got $code: $(head -c 300 "$BODY")"
pass "refunded the order"

# Availability coming back is the end-to-end assertion: the seats really were
# taken out of inventory and really were returned.
code=$(call GET "/events/$EVENT_ID")
[ "$code" = "200" ] || fail "event overview" "expected 200, got $code"
available=$(jq -r '.seats.available' "$BODY")
[ "$available" = "4" ] || fail "availability after refund" "expected 4 available, got $available"
pass "all 4 seats are available again after the refund"

echo
echo "$PASSED checks passed. Event $EVENT_ID was left behind by --full."
echo

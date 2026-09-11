#!/bin/sh
# Container entrypoint.
#
# Required:
#   MAKER_APP   - "perps", "futures", or "portfolio"
#                 ("portfolio" runs perps + all futures expiries in one process)
#
# Config selection (in precedence order):
#   1. CLI arg:  docker run … portfolio --config /custom/path.yml
#   2. MAKER_CONFIG env var
#   3. MAKER_ENV env var → /app/configs/${MAKER_APP}.${MAKER_ENV}.yml
#                           (MAKER_ENV defaults to "prd" inside containers)
set -eu

if [ -z "${MAKER_APP:-}" ]; then
  echo "MAKER_APP must be set to 'perps', 'futures', or 'portfolio'" >&2
  exit 1
fi

case "$MAKER_APP" in
  perps)
    ENTRY="/app/src/apps/perps/main.ts"
    ;;
  futures)
    ENTRY="/app/src/apps/futures/main.ts"
    ;;
  portfolio)
    ENTRY="/app/src/apps/portfolio/main.ts"
    ;;
  *)
    echo "Unknown MAKER_APP='$MAKER_APP' (expected 'perps', 'futures', or 'portfolio')" >&2
    exit 1
    ;;
esac

# If no --config CLI arg and no MAKER_CONFIG was injected, fall back to
# selecting by MAKER_ENV. Production-by-default for safety in container
# images that lack any explicit configuration.
if [ -z "${MAKER_CONFIG:-}" ]; then
  MAKER_ENV="${MAKER_ENV:-prd}"
  case "$MAKER_ENV" in
    local|dev|stg|prd) ;;
    *)
      echo "Unknown MAKER_ENV='$MAKER_ENV' (expected 'local', 'dev', 'stg', or 'prd')" >&2
      exit 1
      ;;
  esac
  export MAKER_CONFIG="/app/configs/${MAKER_APP}.${MAKER_ENV}.yml"
fi

exec node --import=amaro/strip --conditions=typescript "$ENTRY" "$@"

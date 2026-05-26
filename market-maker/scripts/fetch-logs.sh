#!/usr/bin/env sh
# Fetch and pretty-print CloudWatch logs for the Titan market maker.
#
# Usage:
#   sh scripts/fetch-logs.sh futures dev    # base-sepolia
#   sh scripts/fetch-logs.sh perps   dev    # base-sepolia
#   sh scripts/fetch-logs.sh futures stg    # base-mainnet (staging)
#   sh scripts/fetch-logs.sh perps   prd    # base-mainnet (production)
#
# Prerequisites: AWS CLI v2, pnpm, pino-pretty (devDependency).
# AWS credentials are resolved via the named profile (~/.aws/config).

set -eu

VENUE="${1:?usage: sh scripts/fetch-logs.sh <futures|perps> <dev|stg|prd>}"
ENV="${2:?usage: sh scripts/fetch-logs.sh <futures|perps> <dev|stg|prd>}"
REGION="${3:-us-east-1}"

case "$VENUE" in
  futures|perps) ;;
  *) echo "unknown venue: $VENUE (use futures | perps)" >&2; exit 1 ;;
esac

case "$ENV" in
  dev|stg|prd) ;;
  *) echo "unknown env: $ENV (use dev | stg | prd)" >&2; exit 1 ;;
esac

LOG_GROUP="/ecs/col-mar-${VENUE}-mm-${ENV}"

AWS_PROFILE="$ENV" aws logs tail "$LOG_GROUP" \
  --region "$REGION" \
  --follow \
  --format short \
  | sed -E 's/^[^ ]+ //' \
  | pnpm pino-pretty

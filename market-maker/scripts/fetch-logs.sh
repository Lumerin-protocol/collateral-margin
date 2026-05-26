#!/usr/bin/env sh
# Fetch and pretty-print CloudWatch logs for the futures market maker.
#
# Usage:
#   sh scripts/fetch-logs.sh dev    # base-sepolia (development)
#   sh scripts/fetch-logs.sh stg    # base-mainnet (staging)
#   sh scripts/fetch-logs.sh prd    # base-mainnet (production)
#
# Prerequisites: AWS CLI v2, pnpm, pino-pretty (devDependency).
# AWS credentials are resolved via the named profile (~/.aws/config).

set -eu

ENV="${1:-dev}"
REGION="${2:-us-east-1}"

case "$ENV" in
  dev) LOG_GROUP="/ecs/col-mar-futures-mm-dev" ;;
  stg) LOG_GROUP="/ecs/col-mar-futures-mm-stg" ;;
  prd) LOG_GROUP="/ecs/col-mar-futures-mm-prd" ;;
  *)   echo "unknown env: $ENV (use dev | stg | prd)" >&2; exit 1 ;;
esac

AWS_PROFILE="$ENV" aws logs tail "$LOG_GROUP" \
  --region "$REGION" \
  --follow \
  --format short \
  | sed -E 's/^[^ ]+ //' \
  | pnpm pino-pretty

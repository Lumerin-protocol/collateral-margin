#!/usr/bin/env bash
# Walk every block in the user's trade history and compare
# `getPositionIds(user).length` on-chain to the indexer's
# `netQuantityAfter` at that point.
#
# Run:
#   RPC="https://base-sepolia.g.alchemy.com/v2/<key>" \
#   FUT="0x56d8d4a03a0f34b93B86E0b7941aFF29178D0479" \
#   USER="0x1441Bc52156Cf18c12cde6A92aE6BDE8B7f775D4" \
#   bash scripts/diff-indexer-vs-chain.sh

set -euo pipefail

: "${RPC:?set RPC}"
: "${FUT:?set FUT}"
: "${USER:?set USER}"

# (blockNumber, indexerNetQuantityAfter) pairs, ordered.
# Block 41546345 has two trades; both included.
TRADES=(
  41113449:-5
  41113929:-18
  41114063:-17
  41114110:-16
  41114131:-8
  41152064:-11
  41153016:-23
  41154069:-18
  41154191:-9
  41154794:-23
  41169381:-9
  41169439:0
  41190647:3
  41198711:4
  41198907:5
  41198956:7
  41198977:9
  41199080:11
  41199119:8
  41542672:9
  41544708:10
  41546345:14
  41546345:12
  41546372:0
  41546372:-5
)

printf "%-12s %-10s %-10s %-10s %s\n" "block" "indexer" "chainLen" "absMatch" "status"
printf "%-12s %-10s %-10s %-10s %s\n" "-----" "-------" "--------" "--------" "------"

prev_match=""
for entry in "${TRADES[@]}"; do
  block="${entry%%:*}"
  indexer="${entry#*:}"
  abs_indexer="${indexer#-}"

  raw=$(cast call "$FUT" "getPositionIds(address)(bytes32[])" "$USER" \
        --rpc-url "$RPC" --block "$block")
  # raw looks like "[0x..., 0x..., 0x...]" or "[]"
  if [ "$raw" = "[]" ]; then
    chain_len=0
  else
    chain_len=$(printf '%s' "$raw" | tr ',' '\n' | wc -l | tr -d ' ')
  fi

  status="ok"
  if [ "$chain_len" != "$abs_indexer" ]; then
    status="MISMATCH"
  fi

  printf "%-12s %-10s %-10s %-10s %s\n" "$block" "$indexer" "$chain_len" "$abs_indexer" "$status"
done

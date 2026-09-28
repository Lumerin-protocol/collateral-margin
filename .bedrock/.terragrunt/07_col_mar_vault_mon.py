"""
Insurance-fund debt monitor.

One GraphQL query against the vault subgraph, then one eth_call of
collateralToken.balanceOf(vault) at the subgraph's block. Both sides of the
backing check describe the same block, so indexer lag cannot open a false gap.

On any failure this publishes CheckSuccess=0 and no value metrics. Value
alarms treat missing data as ignore and keep their last state.
"""

import json
import os
import time
import urllib.request
from datetime import datetime, timezone

import boto3

SUBGRAPH_URL = os.environ.get("SUBGRAPH_URL", "")
VAULT_ADDRESS = os.environ.get("VAULT_ADDRESS", "").lower()
FUTURES_ADDRESS = os.environ.get("FUTURES_ADDRESS", "").lower()
PERPS_ADDRESS = os.environ.get("PERPS_ADDRESS", "").lower()
ETH_RPC_URL = os.environ.get("ETH_RPC_URL", "")
CW_NAMESPACE = os.environ.get("CW_NAMESPACE", "ColMarVault")

# balanceOf(address)
BALANCE_OF_SELECTOR = "70a08231"

QUERY = """
query VaultDebt($futures: Bytes!, $perps: Bytes!) {
  _meta {
    block { number timestamp }
    hasIndexingErrors
  }
  vault(id: "0") {
    insuranceFundBalance
    insuranceDebt
    insuranceDebtCap
    timingDebt
    uncoveredLoss
    insuranceCapital
    traderBadDebtTotal
    totalSupply
    halted
    marginEngine
    decimals
    collateralToken
  }
  vaultVenues(first: 100) {
    id
    traderBadDebtTotal
  }
  futuresUser: vaultUser(id: $futures) { balance }
  perpsUser: vaultUser(id: $perps) { balance }
}
"""

cloudwatch = boto3.client("cloudwatch")


def log(message):
    print(message)


def rpc_label():
    if not ETH_RPC_URL:
        return "missing"
    head, sep, _tail = ETH_RPC_URL.partition("/v2/")
    return head + sep + "…" if sep else "set"


def post_json(url, payload, timeout=30):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def query_subgraph():
    result = post_json(
        SUBGRAPH_URL,
        {
            "query": QUERY,
            "variables": {"futures": FUTURES_ADDRESS, "perps": PERPS_ADDRESS},
        },
    )
    if result.get("errors"):
        raise RuntimeError("graphql: {}".format(result["errors"]))
    data = result.get("data")
    if not data or not data.get("vault") or not data.get("_meta"):
        raise RuntimeError("graphql response missing vault or _meta")
    return data


def eth_balance(token, holder, block_number):
    holder_word = holder.lower().replace("0x", "").rjust(64, "0")
    payload = {
        "jsonrpc": "2.0",
        "method": "eth_call",
        "params": [
            {"to": token, "data": "0x" + BALANCE_OF_SELECTOR + holder_word},
            hex(block_number),
        ],
        "id": 1,
    }
    result = post_json(ETH_RPC_URL, payload)
    if result.get("error"):
        raise RuntimeError("eth_call: {}".format(result["error"]))
    raw = result.get("result")
    if not raw or raw == "0x":
        raise RuntimeError("eth_call returned empty data")
    return int(raw, 16)


def as_int(value, name):
    if value is None:
        raise RuntimeError("missing {}".format(name))
    return int(value)


def is_unset(address):
    if not address:
        return True
    try:
        return int(address, 16) == 0
    except ValueError:
        return True


def to_units(raw, decimals):
    return raw / float(10 ** decimals)


def utilization_pct(debt, cap):
    # A zero cap with outstanding debt is already past every threshold.
    if cap <= 0:
        return 0.0 if debt <= 0 else 1000.0
    return (debt / float(cap)) * 100.0


def metric(name, value, unit="None", dimensions=None):
    item = {"MetricName": name, "Value": float(value), "Unit": unit}
    if dimensions:
        item["Dimensions"] = dimensions
    return item


def push(metric_data):
    for start in range(0, len(metric_data), 20):
        batch = metric_data[start : start + 20]
        cloudwatch.put_metric_data(Namespace=CW_NAMESPACE, MetricData=batch)
        log("pushed {} metrics".format(len(batch)))


def publish_failure():
    try:
        push([metric("CheckSuccess", 0, "Count")])
    except Exception as exc:
        log("failed to publish CheckSuccess=0: {}".format(exc))


def collect():
    data = query_subgraph()
    meta = data["_meta"]
    block = meta["block"]
    block_number = int(block["number"])
    block_timestamp = int(block["timestamp"])
    vault = data["vault"]
    decimals = int(vault["decimals"]) if vault.get("decimals") is not None else 6
    if decimals < 0 or decimals > 18:
        raise RuntimeError("unexpected decimals {}".format(decimals))

    token = vault.get("collateralToken")
    if not token:
        raise RuntimeError("vault entity has no collateralToken")
    usdc_raw = eth_balance(token, VAULT_ADDRESS, block_number)

    debt = as_int(vault["insuranceDebt"], "insuranceDebt")
    cap = as_int(vault["insuranceDebtCap"], "insuranceDebtCap")
    supply = as_int(vault["totalSupply"], "totalSupply")
    capital = as_int(vault["insuranceCapital"], "insuranceCapital")
    gap_raw = supply - debt - usdc_raw
    gap = to_units(gap_raw, decimals)
    # A 1-unit gap must stay above the >0 alarm after float conversion.
    if gap_raw > 0 and gap <= 0:
        gap = 1.0 / float(10 ** decimals)

    age = max(0, int(time.time()) - block_timestamp)
    futures_balance = 0
    perps_balance = 0
    if data.get("futuresUser") and data["futuresUser"].get("balance") is not None:
        futures_balance = as_int(data["futuresUser"]["balance"], "futures balance")
    if data.get("perpsUser") and data["perpsUser"].get("balance") is not None:
        perps_balance = as_int(data["perpsUser"]["balance"], "perps balance")

    points = [
        metric("InsuranceFundBalance", to_units(as_int(vault["insuranceFundBalance"], "fund"), decimals)),
        metric("InsuranceDebt", to_units(debt, decimals)),
        metric("InsuranceDebtCap", to_units(cap, decimals)),
        metric("InsuranceDebtUtilizationPct", utilization_pct(debt, cap)),
        metric("TimingDebt", to_units(as_int(vault["timingDebt"], "timingDebt"), decimals)),
        metric("UncoveredLoss", to_units(as_int(vault["uncoveredLoss"], "uncoveredLoss"), decimals)),
        metric("InsuranceCapital", to_units(capital, decimals)),
        metric("TraderBadDebtTotal", to_units(as_int(vault["traderBadDebtTotal"], "traderBadDebt"), decimals)),
        metric("Halted", 1 if vault.get("halted") else 0, "Count"),
        metric("FuturesFeeBalance", to_units(futures_balance, decimals)),
        metric("PerpsFeeBalance", to_units(perps_balance, decimals)),
        metric("BackingGap", gap),
        metric("MarginEngineUnset", 1 if is_unset(vault.get("marginEngine")) else 0, "Count"),
        metric("SubgraphDataAgeSeconds", age, "Seconds"),
        metric("SubgraphIndexingErrors", 1 if meta.get("hasIndexingErrors") else 0, "Count"),
        metric("CheckSuccess", 1, "Count"),
    ]
    for venue in data.get("vaultVenues") or []:
        points.append(
            metric(
                "TraderBadDebtTotal",
                to_units(as_int(venue["traderBadDebtTotal"], "venue bad debt"), decimals),
                dimensions=[{"Name": "Venue", "Value": str(venue["id"])}],
            )
        )
    return points, {
        "block": block_number,
        "age": age,
        "debt": debt,
        "gap_raw": gap_raw,
        "halted": bool(vault.get("halted")),
    }


def lambda_handler(event, context):
    log("vault monitor {}".format(datetime.now(timezone.utc).isoformat()))
    log("subgraph set: {} rpc: {}".format(bool(SUBGRAPH_URL), rpc_label()))
    if not SUBGRAPH_URL or not VAULT_ADDRESS or not ETH_RPC_URL:
        log("missing configuration")
        publish_failure()
        return {"statusCode": 500, "body": "missing configuration"}
    try:
        points, summary = collect()
    except Exception as exc:
        log("check failed: {}".format(exc))
        publish_failure()
        return {"statusCode": 500, "body": str(exc)}
    try:
        push(points)
    except Exception as exc:
        log("metric publish failed: {}".format(exc))
        publish_failure()
        return {"statusCode": 500, "body": str(exc)}
    log(
        "ok block={block} age={age}s debt={debt} gap_raw={gap_raw} halted={halted}".format(**summary)
    )
    return {"statusCode": 200, "body": "ok"}

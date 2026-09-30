"""
Insurance-fund debt and protocol-backstop monitor.

One GraphQL query against the vault subgraph, then eth_calls pinned to the
subgraph's block: collateralToken.balanceOf(vault) for the backing check, and
the venues' backstop views (position legs, unrealized PnL, pending funding) for
the backstop equity. Every read describes the same block, so indexer lag cannot
open a false gap.

Conservation (user positions + backstop == 0) comes from the venue subgraphs
when FUTURES_SUBGRAPH_URL / PERPS_SUBGRAPH_URL are set; it is skipped otherwise.

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
POINTS_SUBGRAPH_URL = os.environ.get("POINTS_SUBGRAPH_URL", "")
VAULT_ADDRESS = os.environ.get("VAULT_ADDRESS", "").lower()
FUTURES_ADDRESS = os.environ.get("FUTURES_ADDRESS", "").lower()
PERPS_ADDRESS = os.environ.get("PERPS_ADDRESS", "").lower()
ETH_RPC_URL = os.environ.get("ETH_RPC_URL", "")
CW_NAMESPACE = os.environ.get("CW_NAMESPACE", "ColMarVault")
FUTURES_SUBGRAPH_URL = os.environ.get("FUTURES_SUBGRAPH_URL", "")
PERPS_SUBGRAPH_URL = os.environ.get("PERPS_SUBGRAPH_URL", "")

# CollateralVault.BACKSTOP_ADDR: keyless ledger that inherits liquidated positions.
BACKSTOP_ADDRESS = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

# balanceOf(address)
BALANCE_OF_SELECTOR = "70a08231"
# getRiskView(address) -> (netPositionDelta, unrealizedPnl, pendingFunding, ...)
RISK_VIEW_SELECTOR = "624f962b"
# getActiveExpirationDates(address) -> uint256[]
ACTIVE_EXPIRIES_SELECTOR = "ecd249cb"
# getUserPosition(address,uint256) -> (netQuantity, netEntryValue)   [futures]
FUTURES_POSITION_SELECTOR = "1c88ef1e"
# getUserPosition(address) -> (netQuantity, netEntryValue)           [perps]
PERPS_POSITION_SELECTOR = "5b7c2dad"

UINT256_MOD = 1 << 256
INT256_MAX = (1 << 255) - 1
SUBGRAPH_PAGE = 1000

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
    backstopBalance
    backstopBadDebtTotal
    backstopUnwindBandBps
    backstopUnwindFeeBps
    totalSupply
    halted
    marginEngine
    decimals
    collateralToken
  }
  vaultVenues(first: 100) {
    id
    traderBadDebtTotal
    backstopBadDebtTotal
  }
  futuresUser: vaultUser(id: $futures) { balance }
  perpsUser: vaultUser(id: $perps) { balance }
}
"""

# Every open futures pointer / perps position, paged by id. Summed per market
# (and per expiry for futures) the signed quantities must cancel: the backstop
# inherits liquidated quantity with the user's sign, so it is part of the sum.
FUTURES_POINTERS_QUERY = """
query Pointers($block: Int!, $after: Bytes!, $first: Int!) {
  userDeliverySessionPointers(
    block: { number: $block }, first: $first, orderBy: id, orderDirection: asc,
    where: { id_gt: $after, netQuantity_not: 0 }
  ) { id expirationAt netQuantity }
}
"""

PERPS_USERS_QUERY = """
query Users($block: Int!, $after: Bytes!, $first: Int!) {
  users(
    block: { number: $block }, first: $first, orderBy: id, orderDirection: asc,
    where: { id_gt: $after, netQuantity_not: 0 }
  ) { id netQuantity }
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
    # Goldsky's edge rejects urllib's default User-Agent with 403.
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "col-mar-vault-mon",
        },
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


POINTS_QUERY = """
{
  _meta { block { number } hasIndexingErrors }
}
"""


def eth_block_number():
    payload = {
        "jsonrpc": "2.0",
        "method": "eth_blockNumber",
        "params": [],
        "id": 1,
    }
    result = post_json(ETH_RPC_URL, payload)
    if result.get("error"):
        raise RuntimeError("eth_blockNumber: {}".format(result["error"]))
    raw = result.get("result")
    if not raw:
        raise RuntimeError("eth_blockNumber returned empty data")
    return int(raw, 16)


def eth_block_timestamp(block_number):
    # Goldsky leaves _meta.block.timestamp null. The age alarm needs the
    # timestamp of the block the subgraph actually indexed.
    payload = {
        "jsonrpc": "2.0",
        "method": "eth_getBlockByNumber",
        "params": [hex(block_number), False],
        "id": 1,
    }
    result = post_json(ETH_RPC_URL, payload)
    if result.get("error"):
        raise RuntimeError("eth_getBlockByNumber: {}".format(result["error"]))
    header = result.get("result") or {}
    raw = header.get("timestamp")
    if not raw:
        raise RuntimeError("eth_getBlockByNumber returned no timestamp")
    return int(raw, 16)


def eth_call(to, data, block_number):
    payload = {
        "jsonrpc": "2.0",
        "method": "eth_call",
        "params": [{"to": to, "data": data}, hex(block_number)],
        "id": 1,
    }
    result = post_json(ETH_RPC_URL, payload)
    if result.get("error"):
        raise RuntimeError("eth_call {}: {}".format(data[:10], result["error"]))
    raw = result.get("result")
    if not raw or raw == "0x":
        raise RuntimeError("eth_call {} returned empty data".format(data[:10]))
    return raw[2:]


def word(hex_words, index):
    start = index * 64
    chunk = hex_words[start : start + 64]
    if len(chunk) != 64:
        raise RuntimeError("abi word {} out of range".format(index))
    return int(chunk, 16)


def signed(value):
    return value - UINT256_MOD if value > INT256_MAX else value


def addr_word(address):
    return address.lower().replace("0x", "").rjust(64, "0")


def uint_word(value):
    return "{:064x}".format(value)


def backstop_risk(venue, block_number):
    """(unrealizedPnl, pendingFunding) of the backstop on one venue, raw units."""
    data = "0x" + RISK_VIEW_SELECTOR + addr_word(BACKSTOP_ADDRESS)
    out = eth_call(venue, data, block_number)
    return signed(word(out, 1)), signed(word(out, 2))


def futures_backstop_legs(block_number):
    """[(expirationAt, netQuantity)] the backstop holds on futures, raw units."""
    data = "0x" + ACTIVE_EXPIRIES_SELECTOR + addr_word(BACKSTOP_ADDRESS)
    out = eth_call(FUTURES_ADDRESS, data, block_number)
    offset = word(out, 0) // 32
    count = word(out, offset)
    legs = []
    for i in range(count):
        expiration_at = word(out, offset + 1 + i)
        pos = eth_call(
            FUTURES_ADDRESS,
            "0x" + FUTURES_POSITION_SELECTOR + addr_word(BACKSTOP_ADDRESS) + uint_word(expiration_at),
            block_number,
        )
        net = signed(word(pos, 0))
        if net != 0:
            legs.append((expiration_at, net))
    return legs


def perps_backstop_net(block_number):
    out = eth_call(PERPS_ADDRESS, "0x" + PERPS_POSITION_SELECTOR + addr_word(BACKSTOP_ADDRESS), block_number)
    return signed(word(out, 0))


def page_subgraph(url, query, key, block_number):
    after = "0x"
    while True:
        result = post_json(
            url,
            {"query": query, "variables": {"block": block_number, "after": after, "first": SUBGRAPH_PAGE}},
        )
        if result.get("errors"):
            raise RuntimeError("graphql {}: {}".format(key, result["errors"]))
        rows = (result.get("data") or {}).get(key)
        if rows is None:
            raise RuntimeError("graphql response missing {}".format(key))
        for row in rows:
            yield row
        if len(rows) < SUBGRAPH_PAGE:
            return
        after = rows[-1]["id"]


def futures_imbalance(block_number):
    """Largest |sum of signed pointers| over expiries, raw contract units."""
    by_expiry = {}
    for row in page_subgraph(FUTURES_SUBGRAPH_URL, FUTURES_POINTERS_QUERY, "userDeliverySessionPointers", block_number):
        key = str(row["expirationAt"])
        by_expiry[key] = by_expiry.get(key, 0) + int(row["netQuantity"])
    return max([abs(v) for v in by_expiry.values()] or [0])


def perps_imbalance(block_number):
    total = 0
    for row in page_subgraph(PERPS_SUBGRAPH_URL, PERPS_USERS_QUERY, "users", block_number):
        total += int(row["netQuantity"])
    return abs(total)




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


def blocks_behind(head, indexed):
    if head is None or indexed is None:
        return None
    return max(0, head - indexed)


def points_drift(head):
    # A points failure must not fail the vault debt check.
    if not POINTS_SUBGRAPH_URL or head is None:
        return []
    try:
        result = post_json(POINTS_SUBGRAPH_URL, {"query": POINTS_QUERY})
    except Exception as exc:
        log("points drift failed: {}".format(exc))
        return []
    if result.get("errors"):
        log("points graphql: {}".format(result["errors"]))
        return []
    meta = (result.get("data") or {}).get("_meta") or {}
    block = meta.get("block") or {}
    raw_number = block.get("number")
    if raw_number is None:
        log("points drift missing block number")
        return []
    behind = blocks_behind(head, int(raw_number))
    dims = [{"Name": "Subgraph", "Value": "points"}]
    return [
        metric("SubgraphBlocksBehind", behind, "Count", dims),
        metric("SubgraphIndexingErrors", 1 if meta.get("hasIndexingErrors") else 0, "Count", dims),
    ]


def collect():
    data = query_subgraph()
    meta = data["_meta"]
    block = meta["block"]
    block_number = int(block["number"])
    raw_timestamp = block.get("timestamp")
    block_timestamp = int(raw_timestamp) if raw_timestamp is not None else eth_block_timestamp(block_number)
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
    try:
        head = eth_block_number()
    except Exception as exc:
        log("chain head failed: {}".format(exc))
        head = None
    vault_behind = blocks_behind(head, block_number)
    futures_balance = 0
    perps_balance = 0
    if data.get("futuresUser") and data["futuresUser"].get("balance") is not None:
        futures_balance = as_int(data["futuresUser"]["balance"], "futures balance")
    if data.get("perpsUser") and data["perpsUser"].get("balance") is not None:
        perps_balance = as_int(data["perpsUser"]["balance"], "perps balance")

    backstop_balance = as_int(vault.get("backstopBalance", 0), "backstopBalance")
    backstop_bad_debt = as_int(vault.get("backstopBadDebtTotal", 0), "backstopBadDebtTotal")
    backstop_upnl = 0
    backstop_funding = 0
    futures_legs = []
    perps_net = 0
    if not is_unset(FUTURES_ADDRESS):
        upnl, _funding = backstop_risk(FUTURES_ADDRESS, block_number)
        backstop_upnl += upnl
        futures_legs = futures_backstop_legs(block_number)
    if not is_unset(PERPS_ADDRESS):
        upnl, funding = backstop_risk(PERPS_ADDRESS, block_number)
        backstop_upnl += upnl
        backstop_funding += funding
        perps_net = perps_backstop_net(block_number)
    # Equity the vault would see if every backstop leg were closed at the mark
    # now. Negative means a loss is forming that BadDebt has not recorded yet.
    backstop_equity = backstop_balance + backstop_upnl + backstop_funding

    points = [
        metric("InsuranceFundBalance", to_units(as_int(vault["insuranceFundBalance"], "fund"), decimals)),
        metric("InsuranceDebt", to_units(debt, decimals)),
        metric("InsuranceDebtCap", to_units(cap, decimals)),
        metric("InsuranceDebtUtilizationPct", utilization_pct(debt, cap)),
        metric("TimingDebt", to_units(as_int(vault["timingDebt"], "timingDebt"), decimals)),
        metric("UncoveredLoss", to_units(as_int(vault["uncoveredLoss"], "uncoveredLoss"), decimals)),
        metric("InsuranceCapital", to_units(capital, decimals)),
        metric("TraderBadDebtTotal", to_units(as_int(vault["traderBadDebtTotal"], "traderBadDebt"), decimals)),
        metric("BackstopBadDebtTotal", to_units(backstop_bad_debt, decimals)),
        metric("BackstopBalance", to_units(backstop_balance, decimals)),
        metric("BackstopUnrealizedPnl", to_units(backstop_upnl, decimals)),
        metric("BackstopPendingFunding", to_units(backstop_funding, decimals)),
        metric("BackstopEquity", to_units(backstop_equity, decimals)),
        metric("BackstopUnwindBandBps", as_int(vault.get("backstopUnwindBandBps", 0), "band"), "Count"),
        metric("BackstopUnwindFeeBps", as_int(vault.get("backstopUnwindFeeBps", 0), "fee"), "Count"),
        metric("BackstopOpenLegs", len(futures_legs) + (1 if perps_net != 0 else 0), "Count"),
        # Raw contract units: futures counts whole contracts, perps is 1e6-scaled.
        metric("BackstopFuturesNetQuantity", sum(net for _e, net in futures_legs), "Count"),
        metric("BackstopPerpsNetQuantity", perps_net, "Count"),
        metric("Halted", 1 if vault.get("halted") else 0, "Count"),
        metric("FuturesFeeBalance", to_units(futures_balance, decimals)),
        metric("PerpsFeeBalance", to_units(perps_balance, decimals)),
        metric("BackingGap", gap),
        metric("MarginEngineUnset", 1 if is_unset(vault.get("marginEngine")) else 0, "Count"),
        metric("SubgraphDataAgeSeconds", age, "Seconds"),
        metric("SubgraphIndexingErrors", 1 if meta.get("hasIndexingErrors") else 0, "Count"),
        metric("CheckSuccess", 1, "Count"),
    ]
    if vault_behind is not None:
        points.append(
            metric(
                "SubgraphBlocksBehind",
                vault_behind,
                "Count",
                [{"Name": "Subgraph", "Value": "vault"}],
            )
        )
    points.extend(points_drift(head))
    for venue in data.get("vaultVenues") or []:
        dims = [{"Name": "Venue", "Value": str(venue["id"])}]
        points.append(
            metric(
                "TraderBadDebtTotal",
                to_units(as_int(venue["traderBadDebtTotal"], "venue bad debt"), decimals),
                dimensions=dims,
            )
        )
        points.append(
            metric(
                "BackstopBadDebtTotal",
                to_units(as_int(venue.get("backstopBadDebtTotal", 0), "venue backstop bad debt"), decimals),
                dimensions=dims,
            )
        )
    for expiration_at, net in futures_legs:
        points.append(
            metric(
                "BackstopFuturesNetQuantity",
                net,
                "Count",
                dimensions=[{"Name": "ExpirationAt", "Value": str(expiration_at)}],
            )
        )

    # Conservation: the signed positions of every account, backstop included,
    # cancel per market. A non-zero sum means the indexer or the venue lost a
    # leg; the alarm is on the max imbalance across markets.
    imbalance = 0
    conservation_checked = False
    if FUTURES_SUBGRAPH_URL and not is_unset(FUTURES_ADDRESS):
        imbalance = max(imbalance, futures_imbalance(block_number))
        conservation_checked = True
    if PERPS_SUBGRAPH_URL and not is_unset(PERPS_ADDRESS):
        imbalance = max(imbalance, perps_imbalance(block_number))
        conservation_checked = True
    if conservation_checked:
        points.append(metric("PositionImbalance", imbalance, "Count"))

    return points, {
        "block": block_number,
        "head": head,
        "behind": vault_behind,
        "age": age,
        "debt": debt,
        "gap_raw": gap_raw,
        "halted": bool(vault.get("halted")),
        "backstop_equity": backstop_equity,
        "imbalance": imbalance,
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
        "ok block={block} head={head} behind={behind} age={age}s debt={debt} gap_raw={gap_raw} halted={halted} "
        "backstop_equity={backstop_equity} imbalance={imbalance}".format(**summary)
    )
    return {"statusCode": 200, "body": "ok"}

#!/usr/bin/env python3
"""Measure a Flap native-BNB buy using cast eth_call only. Never signs/broadcasts."""
import argparse
import concurrent.futures
import datetime
import decimal
import json
import os
from pathlib import Path
import re
import statistics
import subprocess
import time

FACTORY = "0xC55820f24015bE7c4f18949D9e1363A3609B300e"
PORTAL = "0x49387D2E6cbF8FefE856e3FBc3E98a01aC3af062"
ZERO = "0x" + "0" * 40
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")


def cast(args, rpc=None):
    started = time.perf_counter()
    env = dict(os.environ, FOUNDRY_DISABLE_NIGHTLY_WARNING="1")
    cmd = ["cast", *map(str, args)]
    if rpc:
        cmd += ["--rpc-url", rpc, "--rpc-timeout", "15"]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=20, env=env)
    return {"ms": round((time.perf_counter() - started) * 1000, 3),
            "exitCode": p.returncode, "stdout": p.stdout.strip(), "stderr": p.stderr.strip()}


def success(result):
    if result["exitCode"]:
        raise RuntimeError(result["stderr"] or result["stdout"])
    return result["stdout"]


def probe_fields(result, required):
    # Decode Solidity Error(string) from raw RPC revert data rather than matching
    # arbitrary terminal text. These Probe methods intentionally revert on success.
    matches = re.findall(r"0x08c379a0[0-9a-fA-F]+", result["stderr"])
    if not matches:
        raise RuntimeError("Unreadable probe: " + result["stderr"])
    raw = bytes.fromhex(matches[-1][10:])
    offset = int.from_bytes(raw[:32], "big")
    if offset + 32 > len(raw):
        raise RuntimeError("Truncated Error(string) offset")
    length = int.from_bytes(raw[offset:offset + 32], "big")
    if offset + 32 + length > len(raw):
        raise RuntimeError("Truncated Error(string) content")
    text = raw[offset + 32:offset + 32 + length].decode("utf-8")
    if not text.endswith(";END"):
        raise RuntimeError("Probe missing ;END")
    values = {}
    for field in text[:-4].split(";"):
        key, value = field.split("=", 1)
        if key in values:
            raise RuntimeError("Duplicate probe field: " + key)
        values[key] = value
    if any(key not in values for key in required):
        raise RuntimeError("Missing required probe fields: " + text)
    return values


def parallel_calls(queries, rpc):
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(queries)) as executor:
        futures = {key: executor.submit(cast, args, rpc) for key, args in queries.items()}
        return {key: future.result() for key, future in futures.items()}


def measure(token, sender, budget, slippage, rpc):
    started = time.perf_counter()
    stages = []
    records = {}

    def stage(label, queries):
        t = time.perf_counter()
        out = parallel_calls(queries, rpc)
        stages.append({"name": label, "ms": round((time.perf_counter() - t) * 1000, 3)})
        records.update(out)
        return out

    r = stage("resolve_market", {"market": ["call", FACTORY, "marketOfToken(address)(address)", token]})
    market = success(r["market"])
    if not ADDRESS.fullmatch(market) or market.lower() == ZERO:
        raise RuntimeError("Token not registered to the configured Flap Factory")

    r = stage("resolve_probe_and_registry", {
        "probe": ["call", FACTORY, "probeOfMarket(address)(address)", market],
        "registered": ["call", FACTORY, "isMarket(address)(bool)", market],
        "portalFactory": ["call", PORTAL, "factory()(address)"],
        "head": ["block-number"],
    })
    probe = success(r["probe"])
    block = int(success(r["head"]))
    if success(r["registered"]) != "true" or success(r["portalFactory"]).lower() != FACTORY.lower():
        raise RuntimeError("Registry binding mismatch")
    if not ADDRESS.fullmatch(probe) or probe.lower() == ZERO:
        raise RuntimeError("No Probe registered for this market")

    def call_probe(signature, *args):
        return ["call", probe, signature, *args, "--from", sender, "--block", block]

    r = stage("bindings_gate_and_balance", {
        "boundMarket": ["call", probe, "market()(address)", "--block", block],
        "asset": call_probe("assetProbe()"),
        "status": call_probe("actionStatusProbe()"),
        "capacity": call_probe("buyCapacityProbe()"),
        "balance": ["balance", sender, "--block", block],
    })
    asset = probe_fields(r["asset"], ["MARKET", "QUOTE", "DECIMALS"])
    status = probe_fields(r["status"], ["BUY_OK", "CLAIM_OK", "PHASE", "TOKEN"])
    capacity = probe_fields(r["capacity"], ["ROOM_SHARES", "HELD_SHARES", "LIMIT_SHARES", "ID", "PHASE"])
    if success(r["boundMarket"]).lower() != market.lower() or asset["MARKET"].lower() != market.lower():
        raise RuntimeError("Probe Market binding mismatch")
    if asset["QUOTE"].lower() != ZERO or asset["DECIMALS"] != "18":
        raise RuntimeError("Benchmark supports native BNB markets only")
    if status["PHASE"] != "1" or status["BUY_OK"] != "1" or capacity["ID"] != "1":
        raise RuntimeError("Market not open or representative sender not eligible: " + json.dumps({"status": status, "capacity": capacity}))
    if int(success(r["balance"])) <= budget:
        raise RuntimeError("Representative sender lacks budget plus gas")

    r = stage("quote_and_plan", {
        "plan": call_probe("buyPlanProbe(uint256,uint256)", budget, slippage),
        "quote": call_probe("quoteBuyProbe(uint256)", budget),
    })
    plan = probe_fields(r["plan"], ["MIN_SHARES", "BUY_SHARES", "RULES_OK", "BLOCK"])
    quote = probe_fields(r["quote"], ["SHARES", "ACCEPT_WEI", "FEE_WEI", "REFUND_WEI", "BLOCK"])
    if plan["RULES_OK"] != "1" or int(plan["BLOCK"]) != block or int(quote["BLOCK"]) != block:
        raise RuntimeError("Plan rejected or inconsistent block")
    r = stage("exact_buy_eth_call", {
        "buy": ["call", PORTAL, "buy(address,uint256)(uint256)", market, plan["MIN_SHARES"],
                "--from", sender, "--value", budget, "--block", block],
    })
    result = success(r["buy"])
    simulated_shares = int(result.split()[0])
    if simulated_shares < int(plan["MIN_SHARES"]):
        raise RuntimeError("Simulation returned shares below minShares")
    return {"block": block, "market": market, "probe": probe,
            "totalMs": round((time.perf_counter() - started) * 1000, 3),
            "stages": stages, "quote": quote, "plan": plan,
            "simulatedSharesRaw": str(simulated_shares),
            "balanceWei": success(records["balance"]), "reads": records}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("token")
    parser.add_argument("--from", dest="sender", required=True, help="eth_call sender only; no private key")
    parser.add_argument("--bnb", default="0.01")
    parser.add_argument("--slippage-bps", type=int, default=100, help="Simulation-only assumption; does not configure live trading")
    parser.add_argument("--runs", type=int, default=7)
    parser.add_argument("--rpc", default="https://bsc-dataseed1.bnbchain.org")
    parser.add_argument("--output", default="research/flap-buy-benchmark.json")
    args = parser.parse_args()
    if not ADDRESS.fullmatch(args.token) or not ADDRESS.fullmatch(args.sender):
        parser.error("token and sender must be 20-byte addresses")
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]{1,18})?", args.bnb) or decimal.Decimal(args.bnb) <= 0:
        parser.error("--bnb must be a positive decimal with at most 18 places")
    if not 0 <= args.slippage_bps < 10000 or not 1 <= args.runs <= 20:
        parser.error("invalid slippage or run count")
    decimal.getcontext().prec = 80
    budget = int(decimal.Decimal(args.bnb) * 10 ** 18)
    runs, errors = [], []
    for index in range(args.runs):
        try:
            sample = measure(args.token, args.sender, budget, args.slippage_bps, args.rpc)
            runs.append(sample)
            print(json.dumps({"run": index + 1, "totalMs": sample["totalMs"], "stages": sample["stages"], "block": sample["block"]}), flush=True)
        except Exception as error:
            errors.append({"run": index + 1, "error": str(error)})
            print(json.dumps(errors[-1]), flush=True)

    chain_sample = None
    try:
        current = json.loads(success(cast(["block", "latest", "--json"], args.rpc)))
        n = int(current["number"], 16)
        previous = json.loads(success(cast(["block", str(n - 128), "--json"], args.rpc)))
        chain_sample = {"fromBlock": n - 128, "toBlock": n,
                        "fromTimestamp": int(previous["timestamp"], 16),
                        "toTimestamp": int(current["timestamp"], 16),
                        "meanBlockIntervalSeconds": (int(current["timestamp"], 16) - int(previous["timestamp"], 16)) / 128}
    except Exception as error:
        chain_sample = {"error": str(error)}

    values = [r["totalMs"] for r in runs]
    summary = ({"successfulRuns": len(values), "failedRuns": len(errors),
                "minMs": min(values), "medianMs": statistics.median(values), "maxMs": max(values),
                "medianStagesMs": {s["name"]: statistics.median(
                    next(x["ms"] for x in r["stages"] if x["name"] == s["name"])
                    for r in runs) for s in runs[0]["stages"]}}
               if values else {"successfulRuns": 0, "failedRuns": len(errors)})
    report = {"measuredAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "scope": "Read-only cast calls; excludes BAW preview/risk/signing, broadcast, mining, receipt polling and human confirmation. No wallet connected, no transaction submitted.",
              "senderType": "Explicit representative public address; NOT the user's connected wallet",
              "assumptions": {"token": args.token, "bnb": args.bnb, "slippageBps": args.slippage_bps, "sender": args.sender, "rpc": args.rpc},
              "method": "Each sample independently resolves registry/probe, checks eligibility and funding, quotes and simulates exact Portal.buy; dependent rounds sequential, independent reads parallel. Includes cast process overhead. State pinned to a fresh block per sample. Single configured Flap adapter, not the full unimplemented three-platform CLI.",
              "summary": summary, "chainSample": chain_sample, "runs": runs, "errors": errors}
    path = Path(args.output)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"summary": summary, "chainSample": chain_sample, "output": str(path)}, indent=2), flush=True)
    if not runs:
        raise SystemExit(1)


if __name__ == "__main__":
    main()

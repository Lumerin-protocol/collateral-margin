import { parentPort } from "node:worker_threads";
import { solveFuturesClosesToTarget } from "@hashpower/portfolio-margin";
import type {
  FuturesSolveRequest,
  FuturesSolveResponse,
} from "./futuresSolver.ts";

parentPort?.on("message", (req: FuturesSolveRequest) => {
  let res: FuturesSolveResponse;
  try {
    const legs = solveFuturesClosesToTarget(
      req.snapshot,
      req.params,
      req.currentPrice,
      req.liquidationFee,
      req.now,
    );
    res = { id: req.id, legs };
  } catch (err) {
    res = {
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  parentPort?.postMessage(res);
});

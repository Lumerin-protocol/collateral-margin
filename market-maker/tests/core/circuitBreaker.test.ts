import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker } from "../../src/core/circuitBreaker.ts";

describe("CircuitBreaker", () => {
  it("starts active and stays active below the threshold", () => {
    const cb = new CircuitBreaker({ quarantineThreshold: 3 });
    assert.equal(cb.state, "active");
    cb.recordError(new Error("x"));
    assert.equal(cb.state, "degraded");
    assert.equal(cb.consecutiveErrors, 1);
    assert.equal(cb.canAttempt(), true);
  });

  it("quarantines at the threshold and blocks until backoff elapses", () => {
    const now = 1_000_000;
    const cb = new CircuitBreaker({ quarantineThreshold: 3, baseBackoffMs: 5_000 });
    cb.recordError(new Error("a"), now);
    cb.recordError(new Error("b"), now);
    cb.recordError(new Error("c"), now);
    assert.equal(cb.state, "quarantined");
    assert.equal(cb.canAttempt(now), false);
    assert.equal(cb.canAttempt(now + 4_999), false);
    assert.equal(cb.canAttempt(now + 5_000), true);
  });

  it("applies exponential backoff capped at maxBackoffMs", () => {
    const now = 0;
    const cb = new CircuitBreaker({
      quarantineThreshold: 1,
      baseBackoffMs: 1_000,
      maxBackoffMs: 4_000,
    });
    cb.recordError(new Error("1"), now); // over=0 -> 1000ms
    assert.equal(cb.canAttempt(now + 999), false);
    assert.equal(cb.canAttempt(now + 1_000), true);
    cb.recordError(new Error("2"), now); // over=1 -> 2000ms
    assert.equal(cb.canAttempt(now + 2_000), true);
    cb.recordError(new Error("3"), now); // over=2 -> 4000ms
    cb.recordError(new Error("4"), now); // over=3 -> 8000ms, capped to 4000ms
    assert.equal(cb.canAttempt(now + 4_000), true);
  });

  it("recovers to active on a single success", () => {
    const cb = new CircuitBreaker({ quarantineThreshold: 2 });
    cb.recordError(new Error("a"));
    cb.recordError(new Error("b"));
    assert.equal(cb.state, "quarantined");
    cb.recordSuccess();
    assert.equal(cb.state, "active");
    assert.equal(cb.consecutiveErrors, 0);
    assert.equal(cb.lastError, null);
    assert.equal(cb.canAttempt(), true);
  });
});

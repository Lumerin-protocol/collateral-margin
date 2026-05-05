import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { serializeError, toErrorInfo } from "../src/errSerializer.ts";

describe("serializeError", () => {
  it("preserves message and stack of a simple Error", () => {
    const err = new Error("short");
    err.stack = "Error: short\n    at fn (test.ts:1:1)";
    const out = serializeError(err);
    assert.equal(out.message, "short");
    assert.equal(out.stack, err.stack);
  });

  it("preserves long messages without truncation", () => {
    const msg = "x".repeat(200);
    const err = new Error(msg);
    const out = serializeError(err);
    assert.equal(out.message, msg);
  });

  it("preserves full stack without truncation", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n" + "    at fn (file.ts:1:1)\n".repeat(10);
    const out = serializeError(err);
    assert.equal(out.stack, err.stack);
  });

  it("includes cause via errWithCause", () => {
    const inner = new Error("root cause");
    const outer = new Error("wrapper", { cause: inner });
    const out = serializeError(outer);
    const cause = out.cause as Record<string, unknown>;
    assert.equal(cause.message, "root cause");
    assert.ok(cause.stack);
  });

  it("strips an `abi` field at any depth", () => {
    const err = new Error("contract");
    (err as unknown as Record<string, unknown>).abi = [{ name: "fake" }];
    (err as unknown as Record<string, unknown>).inner = { abi: [{ name: "deep" }], ok: 1 };
    const out = serializeError(err);
    assert.equal(out.abi, undefined);
    const inner = out.inner as Record<string, unknown>;
    assert.equal(inner.abi, undefined);
    assert.equal(inner.ok, 1);
  });

  it("handles non-Error and null gracefully", () => {
    assert.deepEqual(serializeError("oops"), { raw: "oops" });
    assert.deepEqual(serializeError(null), { raw: null });
  });
});

describe("toErrorInfo", () => {
  it("wraps non-Error as { message }", () => {
    assert.deepEqual(toErrorInfo("plain"), { message: "plain" });
  });
  it("delegates to serializeError for Errors", () => {
    const out = toErrorInfo(new Error("boom"));
    assert.equal(out.message, "boom");
  });
});

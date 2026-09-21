import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { serializeError, toErrorInfo } from "../../src/core/errSerializer.ts";

describe("serializeError", () => {
  it("flattens a simple Error to name, message, and frame-only stack", () => {
    const err = new Error("short");
    err.stack = "Error: short\n    at fn (test.ts:1:1)";
    const out = serializeError(err);
    assert.equal(out.name, "Error");
    assert.equal(out.message, "short");
    assert.equal(out.stack, "    at fn (test.ts:1:1)");
  });

  it("uses only the first line of a multi-line message", () => {
    const err = new Error("first\nthen lots of viem contract call dump");
    const out = serializeError(err);
    assert.equal(out.message, "first");
  });

  it("prefers viem `shortMessage` over `message`", () => {
    const err = new Error("very long viem message with newlines\nand calldata");
    Object.assign(err, { shortMessage: "Tx reverted." });
    const out = serializeError(err);
    assert.equal(out.message, "Tx reverted.");
  });

  it("strips the message preamble from `stack`, keeping only `at` frames", () => {
    const err = new Error("boom");
    err.stack =
      "Error: boom\n    junk header\n    at fn (file.ts:1:1)\n    at g (file.ts:2:2)";
    const out = serializeError(err);
    assert.equal(out.stack, "    at fn (file.ts:1:1)\n    at g (file.ts:2:2)");
  });

  it("does not emit the cause chain (viem cause levels are noisy re-wrappings)", () => {
    const inner = new Error("root cause");
    const outer = new Error("wrapper", { cause: inner });
    const out = serializeError(outer);
    assert.equal(out.causes, undefined);
    assert.equal(out.cause, undefined);
    assert.equal(out.message, "wrapper");
  });

  it("surfaces `errorName` from any level's `data.errorName` (viem custom error)", () => {
    const inner = Object.assign(new Error("inner"), {
      data: { errorName: "FailedCall" },
    });
    const outer = new Error("outer", { cause: inner });
    const out = serializeError(outer);
    assert.equal(out.errorName, "FailedCall");
  });

  it("surfaces a trimmed hex `data` from the chain", () => {
    const huge = `0x${"a".repeat(2000)}`;
    const inner = Object.assign(new Error("rpc"), { data: huge });
    const outer = new Error("outer", { cause: inner });
    const out = serializeError(outer);
    const data = out.data as string;
    assert.ok(data.length < huge.length);
    assert.match(data, /…<\+\d+ chars>$/);
  });

  it("leaves a short `data` selector untouched", () => {
    const err = Object.assign(new Error("e"), { data: "0xd6bda275" });
    const out = serializeError(err);
    assert.equal(out.data, "0xd6bda275");
  });

  it("preserves viem call-site fields when present", () => {
    const err = Object.assign(new Error("contract reverted"), {
      shortMessage: "reverted",
      contractAddress: "0xabc",
      functionName: "updateOrders",
      sender: "0xdef",
    });
    const out = serializeError(err);
    assert.equal(out.contractAddress, "0xabc");
    assert.equal(out.functionName, "updateOrders");
    assert.equal(out.sender, "0xdef");
  });

  it("surfaces a `tenderlyUrl` attached at the venue layer", () => {
    const err = Object.assign(new Error("reverted"), {
      tenderlyUrl: "https://dashboard.tenderly.co/simulator/new?network=84532",
    });
    const out = serializeError(err);
    assert.equal(out.tenderlyUrl, "https://dashboard.tenderly.co/simulator/new?network=84532");
  });

  it("walks a cyclic cause chain without looping (harvest only)", () => {
    const a = Object.assign(new Error("a"), { data: "0xaaaa" });
    const b = new Error("b", { cause: a });
    Object.assign(a, { cause: b });
    const out = serializeError(b);
    assert.equal(out.message, "b");
    assert.equal(out.data, "0xaaaa");
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

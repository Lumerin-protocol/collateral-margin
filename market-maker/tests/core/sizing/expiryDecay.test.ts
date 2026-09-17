import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expirySizeScale, scaleBaseQuantity } from "../../../src/core/sizing/expiryDecay.ts";

describe("expirySizeScale", () => {
  it("keeps full size at index 0", () => {
    assert.equal(expirySizeScale(0, 0.6), 1);
  });

  it("decays geometrically by index", () => {
    assert.ok(Math.abs(expirySizeScale(1, 0.6) - 0.6) < 1e-12);
    assert.ok(Math.abs(expirySizeScale(2, 0.6) - 0.36) < 1e-12);
  });

  it("disables when decay >= 1", () => {
    assert.equal(expirySizeScale(2, 1), 1);
  });

  it("returns 0 when decay <= 0", () => {
    assert.equal(expirySizeScale(1, 0), 0);
  });
});

describe("scaleBaseQuantity", () => {
  it("leaves base unchanged at scale 1", () => {
    assert.equal(scaleBaseQuantity(100n, 1), 100n);
  });

  it("scales and rounds to nearest", () => {
    assert.equal(scaleBaseQuantity(10n, 0.6), 6n);
  });

  it("floors at 1 when base > 0", () => {
    assert.equal(scaleBaseQuantity(2n, 0.1), 1n);
  });

  it("keeps zero base at zero", () => {
    assert.equal(scaleBaseQuantity(0n, 0.6), 0n);
  });
});

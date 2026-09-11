import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { PerpsInstrumentAdapter } from "../../src/adapters/perps/instrument.ts";
import type { PerpsVenueAdapter } from "../../src/adapters/perps/venue.ts";

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const PERPS = "0x2222222222222222222222222222222222222222" as Address;

function makeInstrument(position: { netQuantity: bigint; netEntryValue: bigint }) {
  const venue = {
    address: PERPS,
    wallet: { account: { address: OWNER } },
    publicClient: {
      readContract: async (call: {
        functionName: string;
        args: readonly unknown[];
        abi: readonly unknown[];
      }) => {
        assert.equal(call.functionName, "getUserPosition");
        assert.deepEqual(call.args, [OWNER]);
        assert.deepEqual(call.abi, [
          {
            type: "function",
            name: "getUserPosition",
            stateMutability: "view",
            inputs: [{ name: "_user", type: "address" }],
            outputs: [
              {
                name: "",
                type: "tuple",
                components: [
                  { name: "netQuantity", type: "int256" },
                  { name: "netEntryValue", type: "int256" },
                ],
              },
            ],
          },
        ]);
        return position;
      },
    },
  } as unknown as PerpsVenueAdapter;

  return new PerpsInstrumentAdapter(venue);
}

describe("perps instrument position", () => {
  it("derives a long average entry price from net entry value", async () => {
    const position = await makeInstrument({
      netQuantity: 2_000_000n,
      netEntryValue: 241_000_000n,
    }).getPosition();

    assert.deepEqual(position, {
      netQuantity: 2_000_000n,
      entryPrice: 120_500_000n,
    });
  });

  it("derives a positive average entry price for a short", async () => {
    const position = await makeInstrument({
      netQuantity: -2_500_000n,
      netEntryValue: -300_000_000n,
    }).getPosition();

    assert.deepEqual(position, {
      netQuantity: -2_500_000n,
      entryPrice: 120_000_000n,
    });
  });

  it("uses zero entry price when flat", async () => {
    const position = await makeInstrument({
      netQuantity: 0n,
      netEntryValue: 0n,
    }).getPosition();

    assert.deepEqual(position, { netQuantity: 0n, entryPrice: 0n });
  });
});

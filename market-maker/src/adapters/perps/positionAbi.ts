/** Exact local fragment while the pinned perps ABI still exposes the legacy position tuple. */
export const PerpsPositionAbi = [
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
] as const;

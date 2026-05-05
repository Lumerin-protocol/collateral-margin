/**
 * Hand-authored ABI for the views added to `Futures.sol` for the off-chain
 * market maker. These match the entries that `pnpm sync-abi` will eventually
 * fold into `Futures.ts`; until then they live here so the adapter compiles
 * against the new contract.
 *
 * Keep in sync with `Futures.sol#getOrderIds / getPositionIds / getBidPrices /
 * getAskPrices / getQuantityAtPrice / closeOrder / MAX_ORDER_QTY`.
 */
export const FuturesMmExtensionsAbi = [
  {
    inputs: [],
    name: "MAX_ORDER_QTY",
    outputs: [{ internalType: "int8", name: "", type: "int8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "_participant", type: "address" }],
    name: "getOrderIds",
    outputs: [{ internalType: "bytes32[]", name: "", type: "bytes32[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "_participant", type: "address" }],
    name: "getPositionIds",
    outputs: [{ internalType: "bytes32[]", name: "", type: "bytes32[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "_deliveryDate", type: "uint256" },
      { internalType: "uint256", name: "_maxLevels", type: "uint256" },
    ],
    name: "getBidPrices",
    outputs: [{ internalType: "uint256[]", name: "", type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "_deliveryDate", type: "uint256" },
      { internalType: "uint256", name: "_maxLevels", type: "uint256" },
    ],
    name: "getAskPrices",
    outputs: [{ internalType: "uint256[]", name: "", type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "_deliveryDate", type: "uint256" },
      { internalType: "uint256", name: "_price", type: "uint256" },
      { internalType: "bool", name: "_isBid", type: "bool" },
    ],
    name: "getQuantityAtPrice",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "_orderId", type: "bytes32" }],
    name: "closeOrder",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

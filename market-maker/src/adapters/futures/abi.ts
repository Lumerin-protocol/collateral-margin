export const futuresAbi = [
  {
    inputs: [],
    name: "DeliveryDateExpired",
    type: "error",
  },
  {
    inputs: [],
    name: "DeliveryDateNotAvailable",
    type: "error",
  },
  {
    inputs: [],
    name: "DeliveryDateShouldBeInTheFuture",
    type: "error",
  },
  {
    inputs: [],
    name: "InsufficientMarginBalance",
    type: "error",
  },
  {
    inputs: [],
    name: "InvalidPrice",
    type: "error",
  },
  {
    inputs: [],
    name: "InvalidQty",
    type: "error",
  },
  {
    inputs: [],
    name: "MaxOrdersPerParticipantReached",
    type: "error",
  },
  {
    inputs: [],
    name: "OrderNotBelongToSender",
    type: "error",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "bytes32", name: "orderId", type: "bytes32" },
      { indexed: true, internalType: "address", name: "participant", type: "address" },
    ],
    name: "OrderClosed",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "bytes32", name: "orderId", type: "bytes32" },
      { indexed: true, internalType: "address", name: "participant", type: "address" },
      { indexed: false, internalType: "string", name: "destURL", type: "string" },
      { indexed: false, internalType: "uint256", name: "pricePerDay", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "deliveryAt", type: "uint256" },
      { indexed: false, internalType: "bool", name: "isBuy", type: "bool" },
    ],
    name: "OrderCreated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "bytes32", name: "positionId", type: "bytes32" },
    ],
    name: "PositionClosed",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "bytes32", name: "positionId", type: "bytes32" },
      { indexed: true, internalType: "address", name: "seller", type: "address" },
      { indexed: true, internalType: "address", name: "buyer", type: "address" },
      { indexed: false, internalType: "uint256", name: "sellPricePerDay", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "buyPricePerDay", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "deliveryAt", type: "uint256" },
      { indexed: false, internalType: "string", name: "destURL", type: "string" },
      { indexed: false, internalType: "bytes32", name: "orderId", type: "bytes32" },
    ],
    name: "PositionCreated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "bytes32", name: "positionId", type: "bytes32" },
      { indexed: true, internalType: "address", name: "closedBy", type: "address" },
    ],
    name: "PositionDeliveryClosed",
    type: "event",
  },
  {
    inputs: [
      { internalType: "uint256", name: "_amount", type: "uint256" },
    ],
    name: "addMargin",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "account", type: "address" },
    ],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "_orderId", type: "bytes32" },
    ],
    name: "closeOrder",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "_price", type: "uint256" },
      { internalType: "uint256", name: "_deliveryDate", type: "uint256" },
      { internalType: "string", name: "_destURL", type: "string" },
      { internalType: "int8", name: "_qty", type: "int8" },
    ],
    name: "createOrder",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "deliveryDurationDays",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getDeliveryDates",
    outputs: [{ internalType: "uint256[]", name: "", type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getMarketPrice",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "_participant", type: "address" },
    ],
    name: "getMinMargin",
    outputs: [{ internalType: "int256", name: "", type: "int256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "_orderId", type: "bytes32" },
    ],
    name: "getOrderById",
    outputs: [
      {
        components: [
          { internalType: "bool", name: "isBuy", type: "bool" },
          { internalType: "address", name: "participant", type: "address" },
          { internalType: "string", name: "destURL", type: "string" },
          { internalType: "uint256", name: "pricePerDay", type: "uint256" },
          { internalType: "uint256", name: "deliveryAt", type: "uint256" },
          { internalType: "uint256", name: "createdAt", type: "uint256" },
        ],
        internalType: "struct Futures.Order",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "_participant", type: "address" },
      { internalType: "uint256", name: "_deliveryDate", type: "uint256" },
    ],
    name: "getPositionsByParticipantDeliveryDate",
    outputs: [{ internalType: "bytes32[]", name: "", type: "bytes32[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "minimumPriceIncrement",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes[]", name: "data", type: "bytes[]" },
    ],
    name: "multicall",
    outputs: [{ internalType: "bytes[]", name: "results", type: "bytes[]" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "token",
    outputs: [{ internalType: "contract IERC20", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

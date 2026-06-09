export const IPointsHookAbi = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "maker",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "taker",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "notional",
        "type": "uint256"
      },
      {
        "internalType": "int256",
        "name": "makerFee",
        "type": "int256"
      },
      {
        "internalType": "uint256",
        "name": "takerFee",
        "type": "uint256"
      }
    ],
    "name": "onFill",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "liquidator",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "fee",
        "type": "uint256"
      }
    ],
    "name": "onLiquidation",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;

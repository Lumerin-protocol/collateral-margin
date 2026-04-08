export const IOptionsEnginePortfolioViewAbi = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "user",
        "type": "address"
      }
    ],
    "name": "getNetGreeks",
    "outputs": [
      {
        "internalType": "int256",
        "name": "netDelta",
        "type": "int256"
      },
      {
        "internalType": "uint256",
        "name": "netGamma",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "netVega",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "user",
        "type": "address"
      }
    ],
    "name": "getOptionsReservedMargin",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const;

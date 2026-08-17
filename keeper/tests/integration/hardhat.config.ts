/**
 * Keeper integration-node configuration only.
 *
 * Sibling implementations can exceed EIP-170 while under active development;
 * the integration suite exercises their behavior, not deployability.
 */
export default {
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
      allowUnlimitedContractSize: true,
    },
  },
};

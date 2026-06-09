import { defineConfig } from "hardhat/config";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatMatchstick from "hardhat-matchstick-ts";

export default defineConfig({
  solidity: {
    version: "0.8.28",
  },
  plugins: [hardhatNetworkHelpers, hardhatViem, hardhatMatchstick, hardhatNodeTestRunner],
  paths: {
    tests: {
      nodejs: "integration",
    },
  },
  matchstick: {
    subgraphYaml: "subgraph.yaml",
    schemaPath: "schema.graphql",
  },
  networks: {
    default: {
      type: "edr-simulated",
      mining: {
        auto: true,
      },
    },
  },
});

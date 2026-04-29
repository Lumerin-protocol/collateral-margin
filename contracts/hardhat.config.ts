import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import codegenPlugin from "./plugins/codegen/index.ts";
import { tryLoadEnvFile } from "./lib/env.ts";

tryLoadEnvFile("./../.env");
tryLoadEnvFile(".env");

export default defineConfig({
  plugins: [hardhatToolboxViem, codegenPlugin],
  codegen: {
    contracts: [
      "CollateralVault",
      "ICollateralVault",
      "PortfolioMarginEngine",
      "IPortfolioMarginEngine",
    ],
  },
  paths: {
    tests: "tests",
  },
  solidity: {
    version: "0.8.28",
    npmFilesToBuild: [
      "@openzeppelin/contracts/token/ERC20/IERC20.sol",
      "@openzeppelin/contracts/token/ERC20/ERC20.sol",
      "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol",
      "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol",
      "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol",
      "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol",
      "@openzeppelin/contracts/interfaces/IERC5267.sol",
      "@openzeppelin/contracts/utils/Nonces.sol",
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol",
    ],
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
      enabled: true,
    },
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      mining: {
        auto: true,
      },
    },
    localhost: {
      type: "http",
      url: "http://127.0.0.1:8545",
    },
    "base-sepolia": {
      type: "http",
      chainType: "l1",
      chainId: 84532,
      url: configVariable("ALCHEMY_API_KEY", "https://base-sepolia.g.alchemy.com/v2/{variable}"),
      accounts: [configVariable("PRIVATE_KEY")],
    },
    "base-mainnet": {
      type: "http",
      chainType: "l1",
      chainId: 8453,
      url: configVariable("ALCHEMY_API_KEY", "https://base-mainnet.g.alchemy.com/v2/{variable}"),
      accounts: [configVariable("PRIVATE_KEY")],
    },
  },
});

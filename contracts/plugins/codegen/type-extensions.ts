import type { StringWithArtifactContractNamesAutocompletion } from "hardhat/types/artifacts";

declare module "hardhat/types/config" {
  interface HardhatUserConfig {
    codegen?: {
      /** Contract names (exact or glob) to emit ABI files for. Exports all if omitted. */
      contracts?: StringWithArtifactContractNamesAutocompletion[];
    };
  }

  interface HardhatConfig {
    codegen: {
      contracts: string[];
    };
  }
}

export {};

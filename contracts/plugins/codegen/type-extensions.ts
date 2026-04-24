declare module "hardhat/types/config" {
  interface HardhatUserConfig {
    codegen?: {
      /** Contract names (exact or glob) to emit ABI files for. Exports all if omitted. */
      contracts?: string[];
    };
  }

  interface HardhatConfig {
    codegen: {
      contracts: string[];
    };
  }
}

export {};

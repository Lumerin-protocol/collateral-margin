import "hardhat/types/config";

declare module "hardhat/types/config" {
  interface EnvLoaderUserConfig {
    /** Directory holding the `<env>.env` files, relative to the project root. */
    configDir: string;
    /**
     * Machine-specific or secret `.env` files, relative to the project root.
     * Loaded before the named env file so their values win for overlapping keys
     * (`loadEnvFile` never overwrites an already-set variable).
     */
    overrideEnvFiles: string[];
  }

  interface HardhatUserConfig {
    envLoader?: EnvLoaderUserConfig;
  }
}

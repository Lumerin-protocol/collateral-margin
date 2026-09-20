import { globalOption } from "hardhat/config";
import { ArgumentType } from "hardhat/types/arguments";
import type { HardhatPlugin } from "hardhat/types/plugins";
import "./type-extensions.ts";

/**
 * For `--env <name>`, loads `envLoader.overrideEnvFiles` then `<name>.env`
 * from `envLoader.configDir`, and connects to the network named by its `NETWORK`.
 */
const envLoaderPlugin: HardhatPlugin = {
  id: "env-loader",
  globalOptions: [
    globalOption({
      name: "env",
      description: "The environment to load <env>.env for",
      type: ArgumentType.STRING_WITHOUT_DEFAULT,
      defaultValue: undefined,
    }),
  ],
  hookHandlers: {
    config: () => import("./config-hooks.ts"),
  },
};

export default envLoaderPlugin;

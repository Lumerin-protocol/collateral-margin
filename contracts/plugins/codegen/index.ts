import { overrideTask } from "hardhat/config";
import type { HardhatUserConfig, HardhatConfig } from "hardhat/types/config";
import type { ConfigurationVariableResolver } from "hardhat/types/config";
import type { HardhatPlugin } from "hardhat/types/plugins";
import "./type-extensions.ts";

const codegenPlugin: HardhatPlugin = {
  id: "codegen-after-compile",
  hookHandlers: {
    config: async () => ({
      default: async () => ({
        resolveUserConfig: async (
          userConfig: HardhatUserConfig,
          resolveConfigVar: ConfigurationVariableResolver,
          next: (u: HardhatUserConfig, r: ConfigurationVariableResolver) => Promise<HardhatConfig>,
        ) => {
          const resolved = await next(userConfig, resolveConfigVar);
          resolved.codegen = { contracts: userConfig.codegen?.contracts ?? [] };
          return resolved;
        },
      }),
    }),
  },
  tasks: [
    overrideTask(["compile"])
      .setAction(() => import("./compile-action.ts"))
      .build(),
  ],
};

export default codegenPlugin;

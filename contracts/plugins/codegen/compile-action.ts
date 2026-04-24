import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { TaskArguments } from "hardhat/types/tasks";

export default async function (
  args: TaskArguments,
  hre: HardhatRuntimeEnvironment,
  runSuper: (args: TaskArguments) => Promise<unknown>,
): Promise<void> {
  await runSuper(args);
  const { main } = await import("./export-abi.ts");
  const { contracts } = hre.config.codegen;
  main(contracts.length > 0 ? contracts : undefined);
}

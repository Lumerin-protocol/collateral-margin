import { runVaultAction } from "../lib/vaultHalt.ts";

runVaultAction("halt").catch((error) => {
  console.error(error);
  process.exit(1);
});

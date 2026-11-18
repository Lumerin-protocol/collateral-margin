import { runVaultAction } from "../lib/vaultHalt.ts";

runVaultAction("resume").catch((error) => {
  console.error(error);
  process.exit(1);
});

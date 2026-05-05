export * from "./factory.ts";
export * from "./abi.ts";
export { topUpCollateralWithPermit } from "./collateral.ts";

import { registerPerpsAdapter } from "./factory.ts";
registerPerpsAdapter();

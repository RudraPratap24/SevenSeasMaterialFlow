/** Every module the server runs. Add a new one here (see docs/03-adding-a-module.md). */
import { purchaseSystem } from "../../modules/purchase-system/server/module";
import type { ModuleDef } from "./module";

export const MODULES: ModuleDef[] = [purchaseSystem];

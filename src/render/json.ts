// The machine-readable contract: the Receipt, as is (schemaVersion inside). Renderers own
// presentation; this one owns none.
import type { Receipt } from "../receipt/types.ts";

export const renderJson = (receipt: Receipt | Receipt[]): string => `${JSON.stringify(receipt, null, 2)}\n`;

// The machine-readable contracts: the Receipt or the HistoryReceipt, as is (kind and schemaVersion
// inside). Renderers own presentation; this one owns none.
import type { HistoryReceipt } from "../aggregate/types.ts";
import type { Receipt } from "../receipt/types.ts";

export const renderJson = (value: Receipt | Receipt[] | HistoryReceipt): string => `${JSON.stringify(value, null, 2)}\n`;

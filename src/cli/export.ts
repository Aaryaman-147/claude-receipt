// `claude-receipt export`: an (already redacted, or not) Receipt or HistoryReceipt → SVG → PNG →
// a new file. Never overwrites: files are created exclusively ("wx"), so an existing path is neither
// replaced nor truncated. Default names carry only the receipt's (redacted: 4-character) session id,
// or for a history its period (and "-project" with --project): never a project name or path.
import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadFonts } from "../assets.ts";
import type { HistoryReceipt } from "../aggregate/types.ts";
import type { Receipt } from "../receipt/types.ts";
import { toPng } from "../render/png.ts";
import { toSvg } from "../render/svg.ts";
import { historyView } from "../render/view.ts";
import { layoutReceipt, layoutView, type VisualDoc } from "../render/visual/layout.ts";

export interface ExportOptions { format: "png" | "svg"; output: string | null; cwd: string }
type ExportResult = { path: string } | { error: string };

// Create `path` with `data`, or fail without touching an existing file.
function create(path: string, data: Uint8Array | string): "created" | "exists" {
  let fd: number;
  try { fd = openSync(path, "wx"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return "exists"; throw e; }
  try { writeFileSync(fd, data); } catch (e) { closeSync(fd); unlinkSync(path); throw e; } // writes it all (loops)
  closeSync(fd);
  return "created";
}

// A laid-out receipt → the canonical SVG (and its 2× PNG) → ./<base>.<ext>, then -2, -3, ... rather
// than overwrite an earlier export, or exactly --output.
async function exportDoc(doc: VisualDoc, base: string, opts: ExportOptions): Promise<ExportResult> {
  const fonts = loadFonts();
  const svg = toSvg(doc, fonts);
  const data = opts.format === "png" ? await toPng(svg, fonts) : svg;
  const names = opts.output !== null ? [opts.output] : Array.from({ length: 100 }, (_, i) => `${base}${i ? `-${i + 1}` : ""}.${opts.format}`);
  for (const name of names) {
    const path = resolve(opts.cwd, name);
    try {
      if (create(path, data) === "created") return { path };
    } catch (e) {
      return { error: `could not write ${path}: ${(e as NodeJS.ErrnoException).code ?? "error"}` };
    }
  }
  return { error: opts.output !== null ? `${resolve(opts.cwd, opts.output)} already exists; not overwritten` : `too many earlier exports named ${base}.${opts.format}*; use --output` };
}

export const exportReceipt = (receipt: Receipt, opts: ExportOptions): Promise<ExportResult> =>
  exportDoc(layoutReceipt(receipt), `claude-receipt-${receipt.session.id.slice(0, 8).replace(/[^A-Za-z0-9-]/g, "_")}`, opts);

// A history: the same visual receipt, built from the HistoryReceipt's shared view.
export const exportHistory = (h: HistoryReceipt, opts: ExportOptions): Promise<ExportResult> =>
  exportDoc(layoutView(historyView(h)), `claude-receipt-${h.scope.period}${h.scope.projectFilter ? "-project" : ""}`, opts);

// SVG string → PNG bytes (docs/VISUAL_RECEIPT.md §2): the canonical SVG rasterized by resvg
// (@resvg/resvg-wasm, pinned; WebAssembly, no native code). There is no second layout: the PNG is
// the SVG at `VISUAL.pngScale`. resvg-wasm cannot load system fonts; it sees only the font bytes
// passed in, so text is IBM Plex Mono or the font's missing-glyph box, never a fallback font.
// Output holds only IHDR/IDAT/IEND chunks (no text, time or software metadata) and is deterministic.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import type { FontData } from "./svg.ts";
import { VISUAL } from "./visual/spec.ts";

let ready: Promise<void> | undefined;
// The engine binary ships with the package; it is loaded once per process.
const engine = () => (ready ??= initWasm(readFileSync(createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm"))));

export async function toPng(svg: string, fonts: FontData, scale: number = VISUAL.pngScale): Promise<Uint8Array> {
  await engine();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "zoom", value: scale },
    font: { fontBuffers: [fonts.regular, fonts.bold], defaultFontFamily: VISUAL.font.family, monospaceFamily: VISUAL.font.family },
  });
  try {
    const image = resvg.render();
    try { return image.asPng(); } finally { image.free(); }
  } finally { resvg.free(); }
}

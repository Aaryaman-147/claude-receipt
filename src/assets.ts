// Bundled assets on disk (the only file access the visual receipt needs). Callers load them and
// pass the bytes to the pure renderer. IBM Plex Mono Regular and Bold, unmodified, OFL-1.1
// (assets/fonts/IBMPlexMono-LICENSE.txt; Reserved Font Name "Plex").
import { readFileSync } from "node:fs";
import type { FontData } from "./render/svg.ts";

const FONTS = new URL("../assets/fonts/", import.meta.url);

export const loadFonts = (): FontData => ({
  regular: readFileSync(new URL("IBMPlexMono-Regular.ttf", FONTS)),
  bold: readFileSync(new URL("IBMPlexMono-Bold.ttf", FONTS)),
});

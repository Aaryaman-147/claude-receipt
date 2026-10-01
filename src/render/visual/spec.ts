// The visual receipt's design system (docs/VISUAL_RECEIPT.md §3–§5), in one place. Layout and SVG
// read every size, colour and spacing from here; nothing else in the visual renderer is a magic number.
// Font metrics are IBM Plex Mono's, read from the bundled TTF files (unitsPerEm 1000, advance 600,
// ascender 1025, descender -275).
export const VISUAL = {
  canvas: { width: 624, gutter: 24, backdrop: "#E8E5DE" },
  paper: { width: 576, padX: 36, fill: "#FAF8F2" },
  shadow: { dy: 2, blur: 3, color: "#1C1C1A", opacity: 0.18 },
  ink: { primary: "#1C1C1A", secondary: "#6B6A64" },
  font: { family: "IBM Plex Mono", advanceEm: 0.6, ascentEm: 1.025, descentEm: 0.275 },
  type: {
    title: { size: 40, weight: 700, lineHeight: 56, letterSpacing: 6 },
    heading: { size: 20, weight: 700, lineHeight: 28 },
    body: { size: 20, weight: 400, lineHeight: 28 },
    small: { size: 15, weight: 400, lineHeight: 20 },
  },
  grid: { columns: 42, markColumns: 2 }, // 504 px text area / 12 px body cells; the last 2 hold the derived mark
  sectionGap: 24,
  edge: { tooth: 12, depth: 6, allowance: 40 },
  rule: { stroke: 1.5, doubleGap: 3, dashStroke: 1, dash: 4, dashGap: 4, totalColumns: 14 },
  leader: { pitch: 6, dot: 2 },
  band: { height: 36 },
  titleMaxLines: 3,
  ellipsis: "…",
} as const;

export type TypeRole = keyof typeof VISUAL.type;
export const cell = (size: number) => size * VISUAL.font.advanceEm;
export const TEXT_LEFT = VISUAL.canvas.gutter + VISUAL.paper.padX; // 60
export const TEXT_WIDTH = VISUAL.paper.width - 2 * VISUAL.paper.padX; // 504
export const TEXT_RIGHT = TEXT_LEFT + TEXT_WIDTH; // 564
// Baseline offset inside a line box: the font's ascent+descent box, centred vertically.
export const baselineIn = (role: TypeRole) => {
  const { size, lineHeight } = VISUAL.type[role];
  const { ascentEm, descentEm } = VISUAL.font;
  return (lineHeight - (ascentEm + descentEm) * size) / 2 + ascentEm * size;
};

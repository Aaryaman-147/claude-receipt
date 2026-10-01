// VisualDoc → SVG string: the canonical visual receipt (docs/VISUAL_RECEIPT.md). Pure and
// deterministic: the same VisualDoc and font bytes always give the same bytes. Real <text> (readable,
// selectable, searchable); the bundled IBM Plex Mono is embedded unmodified as @font-face data URIs
// when font bytes are passed. The SVG holds only what is drawn: no <title>/<desc>, comments, data-*
// attributes, scripts or hidden elements.
import type { VisualDoc, VisualItem } from "./visual/layout.ts";
import { VISUAL } from "./visual/spec.ts";

export interface FontData { regular: Uint8Array; bold: Uint8Array }

const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const INK = { primary: VISUAL.ink.primary, secondary: VISUAL.ink.secondary, paper: VISUAL.paper.fill } as const;

function item(i: VisualItem): string {
  switch (i.kind) {
    case "text": {
      const size = VISUAL.type[i.role].size;
      const attrs = [
        `x="${num(i.x)}"`, `y="${num(i.y)}"`, `font-size="${size}"`,
        ...(i.weight === 700 ? [`font-weight="700"`] : []),
        `fill="${INK[i.ink]}"`,
        ...(i.anchor !== "start" ? [`text-anchor="${i.anchor}"`] : []),
        ...(i.letterSpacing ? [`letter-spacing="${num(i.letterSpacing)}"`] : []),
        // characters outside printable ASCII may fall back to another font: pin the run to its grid width
        ...(i.pinned ? [`textLength="${num(i.width)}"`, `lengthAdjust="spacingAndGlyphs"`] : []),
      ];
      return `<text ${attrs.join(" ")}>${esc(i.text)}</text>`;
    }
    case "rule": {
      if (i.style === "dashed") {
        return `<line x1="${num(i.x1)}" y1="${num(i.y)}" x2="${num(i.x2)}" y2="${num(i.y)}" stroke="${VISUAL.ink.primary}" stroke-width="${VISUAL.rule.dashStroke}" stroke-dasharray="${VISUAL.rule.dash} ${VISUAL.rule.dashGap}"/>`;
      }
      const off = (VISUAL.rule.doubleGap + VISUAL.rule.stroke) / 2;
      return [i.y - off, i.y + off].map((y) => `<line x1="${num(i.x1)}" y1="${num(y)}" x2="${num(i.x2)}" y2="${num(y)}" stroke="${VISUAL.ink.primary}" stroke-width="${VISUAL.rule.stroke}"/>`).join("");
    }
    case "leader":
      return `<line x1="${num(i.x1)}" y1="${num(i.y)}" x2="${num(i.x2)}" y2="${num(i.y)}" stroke="${VISUAL.ink.secondary}" stroke-width="${VISUAL.leader.dot}" stroke-linecap="round" stroke-dasharray="0 ${VISUAL.leader.pitch}"/>`;
    case "band":
      return `<rect x="${num(i.x)}" y="${num(i.y)}" width="${num(i.width)}" height="${num(i.height)}" fill="${VISUAL.ink.primary}"/>`;
  }
}

export function toSvg(doc: VisualDoc, fonts?: FontData): string {
  const face = (bytes: Uint8Array, weight: number) =>
    `@font-face{font-family:"${VISUAL.font.family}";font-weight:${weight};src:url(data:font/ttf;base64,${Buffer.from(bytes).toString("base64")}) format("truetype")}`;
  const css = `${fonts ? face(fonts.regular, 400) + face(fonts.bold, 700) : ""}text{font-family:"${VISUAL.font.family}",monospace;white-space:pre}`;
  const { shadow } = VISUAL;
  const paper = `M${doc.paper.outline.map(([x, y]) => `${num(x)} ${num(y)}`).join("L")}Z`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${doc.width}" height="${num(doc.height)}" viewBox="0 0 ${doc.width} ${num(doc.height)}" xml:space="preserve">`,
    `<defs><style>${css}</style>`,
    `<filter id="paper-shadow" x="-5%" y="-2%" width="110%" height="104%"><feDropShadow dx="0" dy="${shadow.dy}" stdDeviation="${shadow.blur}" flood-color="${shadow.color}" flood-opacity="${shadow.opacity}"/></filter></defs>`,
    `<rect width="${doc.width}" height="${num(doc.height)}" fill="${doc.backdrop}"/>`,
    `<path d="${paper}" fill="${doc.paper.fill}" filter="url(#paper-shadow)"/>`,
    ...doc.items.map(item),
    "</svg>",
    "",
  ].join("\n");
}

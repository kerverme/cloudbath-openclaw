/**
 * Composes several encoded images into ONE raster grid image.
 *
 * This exists because the image backend is raster-only: Rastermill refuses SVG
 * outright ("Unable to determine image dimensions"), so a grid described as SVG
 * and handed to it can never be rasterized. Everything here therefore works in
 * straight RGBA and emits a real PNG, which every downstream encode/probe path
 * already accepts.
 *
 * Labels are ASCII-only by design and drawn from the bitmap below rather than a
 * font. Generative models and bundled bitmap fonts both render non-Latin
 * scripts unreliably, so callers pass a short index label ("1".."6") and keep
 * prose out of the pixels.
 */
import { encodePngRgba } from "./png-encode.ts";

/** One panel to place, in grid order. */
export type ImageGridPanel = Readonly<{
  bytes: Uint8Array;
  /** Short ASCII label drawn above the panel. Non-ASCII is dropped, not transliterated. */
  label?: string;
}>;

/** Already-decoded panel pixels, so layout can be exercised without a decoder. */
export type DecodedGridPanel = Readonly<{
  pixels: Uint8Array;
  width: number;
  height: number;
  label?: string;
}>;

export type ImageGridLayout = Readonly<{
  /** Panels per row. The row count follows from the panel count. */
  columns: number;
  cellWidth: number;
  cellHeight: number;
  /** Height of the label strip ABOVE each cell. Zero disables labels. */
  labelHeight: number;
}>;

export type ComposedImageGrid = Readonly<{
  bytes: Uint8Array;
  mimeType: "image/png";
  width: number;
  height: number;
  columns: number;
  rows: number;
}>;

export const DEFAULT_IMAGE_GRID_LAYOUT: ImageGridLayout = Object.freeze({
  columns: 2,
  cellWidth: 512,
  cellHeight: 320,
  labelHeight: 48,
});

const BACKGROUND = Object.freeze([17, 24, 39] as const);
const LABEL_COLOR = Object.freeze([255, 255, 255] as const);

/**
 * 3x5 bitmap glyphs for the only characters a panel label may contain.
 *
 * A label identifies a panel's position, so digits plus a few separators cover
 * it. Anything else is dropped rather than approximated — a wrong glyph in a
 * reference artifact is worse than no glyph.
 */
const GLYPHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "/": ["001", "001", "010", "100", "100"],
  "-": ["000", "000", "111", "000", "000"],
  ".": ["000", "000", "000", "000", "100"],
  " ": ["000", "000", "000", "000", "000"],
});

const GLYPH_WIDTH = 3;
const GLYPH_HEIGHT = 5;

/** Keeps only characters the bitmap can actually draw. */
function drawableLabel(label: string): string {
  let drawable = "";
  for (const character of label) {
    if (character in GLYPHS) {
      drawable += character;
    }
  }
  return drawable;
}

function setPixel(
  canvas: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  x: number,
  y: number,
  rgb: readonly [number, number, number],
): void {
  if (x < 0 || y < 0 || x >= canvasWidth || y >= canvasHeight) {
    return;
  }
  const offset = (y * canvasWidth + x) * 4;
  canvas[offset] = rgb[0];
  canvas[offset + 1] = rgb[1];
  canvas[offset + 2] = rgb[2];
  canvas[offset + 3] = 255;
}

/** Draws a label at `scale` pixels per bitmap cell, left-aligned from (x, y). */
function drawLabel(
  canvas: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  label: string,
  x: number,
  y: number,
  scale: number,
): void {
  let cursor = x;
  for (const character of drawableLabel(label)) {
    const glyph = GLYPHS[character]!;
    for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
      const bits = glyph[row]!;
      for (let column = 0; column < GLYPH_WIDTH; column += 1) {
        if (bits[column] !== "1") {
          continue;
        }
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            setPixel(
              canvas,
              canvasWidth,
              canvasHeight,
              cursor + column * scale + dx,
              y + row * scale + dy,
              LABEL_COLOR,
            );
          }
        }
      }
    }
    cursor += (GLYPH_WIDTH + 1) * scale;
  }
}

/**
 * Box-samples a decoded panel into its cell, preserving aspect ratio and
 * centering the result ("contain"), so a panel is never stretched or cropped.
 */
function blitPanel(
  canvas: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  panel: DecodedGridPanel,
  cellX: number,
  cellY: number,
  cellWidth: number,
  cellHeight: number,
): void {
  const scale = Math.min(cellWidth / panel.width, cellHeight / panel.height);
  const drawWidth = Math.max(1, Math.round(panel.width * scale));
  const drawHeight = Math.max(1, Math.round(panel.height * scale));
  const offsetX = cellX + Math.floor((cellWidth - drawWidth) / 2);
  const offsetY = cellY + Math.floor((cellHeight - drawHeight) / 2);
  for (let y = 0; y < drawHeight; y += 1) {
    const sourceY = Math.min(panel.height - 1, Math.floor((y * panel.height) / drawHeight));
    for (let x = 0; x < drawWidth; x += 1) {
      const sourceX = Math.min(panel.width - 1, Math.floor((x * panel.width) / drawWidth));
      const source = (sourceY * panel.width + sourceX) * 4;
      setPixel(canvas, canvasWidth, canvasHeight, offsetX + x, offsetY + y, [
        panel.pixels[source] ?? 0,
        panel.pixels[source + 1] ?? 0,
        panel.pixels[source + 2] ?? 0,
      ]);
    }
  }
}

/**
 * Lays decoded panels out in row-major order and returns the canvas pixels.
 *
 * Separated from decoding so the geometry — ordering, row count, label
 * placement — is testable without a WASM decoder in the loop.
 */
export function drawImageGrid(
  panels: readonly DecodedGridPanel[],
  layout: ImageGridLayout = DEFAULT_IMAGE_GRID_LAYOUT,
): Readonly<{ pixels: Uint8Array; width: number; height: number; columns: number; rows: number }> {
  if (panels.length === 0) {
    throw new Error("An image grid needs at least one panel");
  }
  const columns = Math.max(1, Math.floor(layout.columns));
  const rows = Math.ceil(panels.length / columns);
  const cellTotalHeight = layout.cellHeight + layout.labelHeight;
  const width = columns * layout.cellWidth;
  const height = rows * cellTotalHeight;
  const canvas = new Uint8Array(width * height * 4);
  for (let index = 0; index < canvas.length; index += 4) {
    canvas[index] = BACKGROUND[0];
    canvas[index + 1] = BACKGROUND[1];
    canvas[index + 2] = BACKGROUND[2];
    canvas[index + 3] = 255;
  }
  panels.forEach((panel, index) => {
    const cellX = (index % columns) * layout.cellWidth;
    const cellY = Math.floor(index / columns) * cellTotalHeight;
    if (layout.labelHeight > 0) {
      const scale = Math.max(1, Math.floor(layout.labelHeight / (GLYPH_HEIGHT * 2)));
      drawLabel(
        canvas,
        width,
        height,
        panel.label ?? String(index + 1),
        cellX + scale * 4,
        cellY + Math.max(0, Math.floor((layout.labelHeight - GLYPH_HEIGHT * scale) / 2)),
        scale,
      );
    }
    blitPanel(
      canvas,
      width,
      height,
      panel,
      cellX,
      cellY + layout.labelHeight,
      layout.cellWidth,
      layout.cellHeight,
    );
  });
  return { pixels: canvas, width, height, columns, rows };
}

/** Decodes every panel and composes them into one PNG grid. */
export async function composeImageGrid(
  panels: readonly ImageGridPanel[],
  layout: ImageGridLayout = DEFAULT_IMAGE_GRID_LAYOUT,
): Promise<ComposedImageGrid> {
  const { decodeToRgbaWithPhoton } = await import("./photon.runtime.js");
  const decoded = panels.map((panel, index) => {
    const image = decodeToRgbaWithPhoton(Buffer.from(panel.bytes));
    return {
      pixels: image.pixels,
      width: image.width,
      height: image.height,
      label: panel.label ?? String(index + 1),
    };
  });
  const grid = drawImageGrid(decoded, layout);
  return {
    bytes: encodePngRgba(Buffer.from(grid.pixels), grid.width, grid.height),
    mimeType: "image/png",
    width: grid.width,
    height: grid.height,
    columns: grid.columns,
    rows: grid.rows,
  };
}

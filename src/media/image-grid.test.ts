/**
 * The grid compositor exists because the raster backend refuses SVG. These
 * tests therefore assert two different things: that the geometry is right
 * (pure, no decoder), and that what comes out is an image the SAME backend can
 * probe and re-encode — the step that used to fail in production.
 */
import { createRastermill } from "rastermill";
import { describe, expect, it } from "vitest";
import { composeImageGrid, drawImageGrid, type DecodedGridPanel } from "./image-grid.ts";
import { encodePngRgba } from "./png-encode.ts";

const LAYOUT = { columns: 2, cellWidth: 40, cellHeight: 30, labelHeight: 10 } as const;

/** A solid panel whose color identifies it once composited. */
function panel(r: number, g: number, b: number, width = 8, height = 6): DecodedGridPanel {
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = r;
    pixels[index * 4 + 1] = g;
    pixels[index * 4 + 2] = b;
    pixels[index * 4 + 3] = 255;
  }
  return { pixels, width, height };
}

function pixelAt(
  grid: Readonly<{ pixels: Uint8Array; width: number }>,
  x: number,
  y: number,
): [number, number, number] {
  const offset = (y * grid.width + x) * 4;
  return [grid.pixels[offset]!, grid.pixels[offset + 1]!, grid.pixels[offset + 2]!];
}

const SIX = [
  panel(255, 0, 0),
  panel(0, 255, 0),
  panel(0, 0, 255),
  panel(255, 255, 0),
  panel(255, 0, 255),
  panel(0, 255, 255),
];

describe("six panels become a 2x3 grid", () => {
  it("lays six panels out as 2 columns by 3 rows", () => {
    const grid = drawImageGrid(SIX, LAYOUT);

    expect(grid.columns).toBe(2);
    expect(grid.rows).toBe(3);
    expect(grid.width).toBe(2 * LAYOUT.cellWidth);
    expect(grid.height).toBe(3 * (LAYOUT.cellHeight + LAYOUT.labelHeight));
  });

  it("places panels in reading order 1,2 / 3,4 / 5,6", () => {
    const grid = drawImageGrid(SIX, LAYOUT);
    const cellHeight = LAYOUT.cellHeight + LAYOUT.labelHeight;
    // Center of each cell's image area, which is below that cell's label strip.
    const centerOf = (index: number) =>
      pixelAt(
        grid,
        (index % 2) * LAYOUT.cellWidth + LAYOUT.cellWidth / 2,
        Math.floor(index / 2) * cellHeight + LAYOUT.labelHeight + LAYOUT.cellHeight / 2,
      );

    expect(centerOf(0)).toEqual([255, 0, 0]);
    expect(centerOf(1)).toEqual([0, 255, 0]);
    expect(centerOf(2)).toEqual([0, 0, 255]);
    expect(centerOf(3)).toEqual([255, 255, 0]);
    expect(centerOf(4)).toEqual([255, 0, 255]);
    expect(centerOf(5)).toEqual([0, 255, 255]);
  });

  it("draws a label strip above each panel rather than over the artwork", () => {
    const grid = drawImageGrid(SIX, LAYOUT);
    // Some pixel in the first label strip is lit; the artwork below is untouched.
    let litLabelPixels = 0;
    for (let y = 0; y < LAYOUT.labelHeight; y += 1) {
      for (let x = 0; x < LAYOUT.cellWidth; x += 1) {
        if (pixelAt(grid, x, y)[0] === 255 && pixelAt(grid, x, y)[2] === 255) {
          litLabelPixels += 1;
        }
      }
    }

    expect(litLabelPixels).toBeGreaterThan(0);
    expect(pixelAt(grid, LAYOUT.cellWidth / 2, LAYOUT.labelHeight + LAYOUT.cellHeight / 2)).toEqual(
      [255, 0, 0],
    );
  });

  it("drops non-ASCII label characters instead of drawing wrong glyphs", () => {
    // Thai cannot be drawn from the bitmap; it must not become garbage pixels.
    const thai = drawImageGrid([{ ...panel(255, 0, 0), label: "ฉากที่" }], LAYOUT);
    const blank = drawImageGrid([{ ...panel(255, 0, 0), label: "" }], LAYOUT);

    expect(Buffer.from(thai.pixels)).toEqual(Buffer.from(blank.pixels));
  });

  it("keeps a panel's aspect ratio instead of stretching it", () => {
    // A wide panel in a taller cell leaves background above and below, not a stretch.
    const grid = drawImageGrid([panel(255, 0, 0, 40, 5)], LAYOUT);

    expect(pixelAt(grid, LAYOUT.cellWidth / 2, LAYOUT.labelHeight + 1)).toEqual([17, 24, 39]);
    expect(pixelAt(grid, LAYOUT.cellWidth / 2, LAYOUT.labelHeight + LAYOUT.cellHeight / 2)).toEqual(
      [255, 0, 0],
    );
  });

  it("refuses an empty grid rather than emitting a zero-sized image", () => {
    expect(() => drawImageGrid([], LAYOUT)).toThrow("at least one panel");
  });
});

describe("the composed sheet is an image the raster backend accepts", () => {
  it("produces a PNG the same backend can probe and re-encode", async () => {
    const rastermill = createRastermill({ execution: "auto" });
    const encodedPanels = await Promise.all(
      SIX.map(async (source) => {
        const png = encodePngRgba(Buffer.from(source.pixels), source.width, source.height);
        const jpeg = await rastermill.encode(png, { format: "jpeg", quality: 90 });
        return { bytes: jpeg.data };
      }),
    );

    const sheet = await composeImageGrid(encodedPanels, {
      columns: 2,
      cellWidth: 64,
      cellHeight: 48,
      labelHeight: 16,
    });

    expect(sheet.mimeType).toBe("image/png");
    expect(sheet.columns).toBe(2);
    expect(sheet.rows).toBe(3);
    // The exact call that threw "Unable to determine image dimensions" on SVG.
    const probed = await rastermill.probe(sheet.bytes);
    expect(probed?.width).toBe(sheet.width);
    expect(probed?.height).toBe(sheet.height);
    const normalized = await rastermill.encode(sheet.bytes, {
      format: "jpeg",
      resize: { maxSide: 2048 },
      quality: 88,
    });
    expect(normalized.data.byteLength).toBeGreaterThan(0);
  });
});

import photon from "@silvia-odwyer/photon-node";

/** Straight RGBA pixels plus the dimensions they are strided by. */
export type DecodedRgbaImage = Readonly<{
  pixels: Uint8Array;
  width: number;
  height: number;
}>;

/**
 * Decodes encoded image bytes to straight RGBA.
 *
 * Rastermill deliberately exposes no pixel access — it encodes and probes
 * whole files. Anything that has to READ pixels (compositing several images
 * into one canvas) needs a decoder, and Photon is the one already vendored.
 */
export function decodeToRgbaWithPhoton(buffer: Buffer): DecodedRgbaImage {
  let image: InstanceType<typeof photon.PhotonImage> | undefined;
  try {
    image = photon.PhotonImage.new_from_byteslice(buffer);
    const width = image.get_width();
    const height = image.get_height();
    const pixels = image.get_raw_pixels();
    if (!width || !height || pixels.length < width * height * 4) {
      throw new Error("Decoded image pixels do not match its reported dimensions");
    }
    // Copied out of WASM memory before `free()` invalidates the view.
    return { pixels: Uint8Array.from(pixels), width, height };
  } finally {
    image?.free();
  }
}

/** Decode validated BMP bytes only after Rastermill rejects the format. */
export function convertBmpToPngWithPhoton(buffer: Buffer): Buffer {
  let image: InstanceType<typeof photon.PhotonImage> | undefined;
  try {
    image = photon.PhotonImage.new_from_byteslice(buffer);
    return Buffer.from(image.get_bytes());
  } finally {
    image?.free();
  }
}

import sharp from "sharp";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_BYTES = 256 * 1024;
const MAX_PIXELS = 1_048_576;
const MAX_ICO_FRAMES = 64;
const SIZE = 32;

type IconImageFormat = "png" | "jpeg" | "gif" | "webp" | "ico";
type IconFrame = { body: Buffer; width: number; height: number; bits: number };

/** Sniff only raster formats we explicitly decode; MIME labels are not trustworthy. */
export function iconImageFormat(body: Buffer): IconImageFormat | undefined {
  if (body.subarray(0, 8).equals(PNG)) return "png";
  if (body[0] === 255 && body[1] === 216 && body[2] === 255) return "jpeg";
  if (/^(GIF87a|GIF89a)$/.test(body.subarray(0, 6).toString("latin1"))) return "gif";
  if (
    body.subarray(0, 4).toString("latin1") === "RIFF" &&
    body.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "webp";
  }
  if (body.length >= 6 && body.readUInt32LE(0) === 0x00010000) return "ico";
  return undefined;
}

function invalid(): never {
  throw new Error("Icon unavailable");
}

function icoFrame(body: Buffer): IconFrame {
  const count = body.readUInt16LE(4);
  const directoryEnd = 6 + count * 16;
  if (!count || count > MAX_ICO_FRAMES || directoryEnd > body.length) invalid();
  const frames: IconFrame[] = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    const length = body.readUInt32LE(entry + 8);
    const offset = body.readUInt32LE(entry + 12);
    if (
      body[entry + 3] !== 0 ||
      body.readUInt16LE(entry + 4) > 1 ||
      length < 4 ||
      offset < directoryEnd ||
      offset > body.length ||
      length > body.length - offset
    ) {
      invalid();
    }
    frames.push({
      body: body.subarray(offset, offset + length),
      width: body[entry] || 256,
      height: body[entry + 1] || 256,
      bits: body.readUInt16LE(entry + 6),
    });
  }
  // Prefer the smallest frame large enough for 32px; otherwise use the largest available.
  const rank = (frame: IconFrame) => {
    const side = Math.min(frame.width, frame.height);
    return side >= SIZE ? side - SIZE : 256 + SIZE - side;
  };
  frames.sort((a, b) => rank(a) - rank(b) || b.bits - a.bits);
  return frames[0];
}

function dibPixels({ body, width, height }: IconFrame): Buffer {
  // Support the common BITMAPINFOHEADER + BI_RGB form, not compressed/bitfield/legacy DIBs.
  if (
    body.length < 40 ||
    body.readUInt32LE(0) !== 40 ||
    body.readInt32LE(4) !== width ||
    Math.abs(body.readInt32LE(8)) !== height * 2 ||
    body.readUInt16LE(12) !== 1 ||
    body.readUInt32LE(16) !== 0
  ) {
    invalid();
  }
  const bits = body.readUInt16LE(14);
  if (![1, 4, 8, 24, 32].includes(bits)) invalid();
  const colorsUsed = body.readUInt32LE(32);
  const colors = bits <= 8 ? colorsUsed || 2 ** bits : 0;
  if ((bits <= 8 && colors > 2 ** bits) || (bits > 8 && colorsUsed !== 0)) invalid();
  const stride = Math.ceil((width * bits) / 32) * 4;
  const maskStride = Math.ceil(width / 32) * 4;
  const pixelsStart = 40 + colors * 4;
  const maskStart = pixelsStart + stride * height;
  if (maskStart + maskStride * height > body.length) invalid();

  // Windows treats an entirely zero 32-bit alpha channel as legacy 0RGB + AND mask.
  // Otherwise normal icon drawing uses the alpha channel, ignoring the fallback mask.
  // https://devblogs.microsoft.com/oldnewthing/20101021-00/?p=12483
  let hasAlpha = false;
  if (bits === 32) {
    for (let y = 0; y < height && !hasAlpha; y++) {
      for (let x = 0; x < width; x++) {
        if (body[pixelsStart + y * stride + x * 4 + 3] !== 0) {
          hasAlpha = true;
          break;
        }
      }
    }
  }

  // Directory bytes bound each side to 256; all frame/palette/mask spans were checked above.
  const rgba = Buffer.alloc(width * height * 4);
  const bottomUp = body.readInt32LE(8) > 0;
  for (let y = 0; y < height; y++) {
    const sourceY = bottomUp ? height - 1 - y : y;
    const row = pixelsStart + sourceY * stride;
    const maskRow = maskStart + sourceY * maskStride;
    for (let x = 0; x < width; x++) {
      let source = row + x * (bits / 8);
      if (bits <= 8) {
        const packed = body[row + Math.floor((x * bits) / 8)];
        const index = (packed >> (8 - bits - ((x * bits) % 8))) & ((1 << bits) - 1);
        if (index >= colors) invalid();
        source = 40 + index * 4;
      }
      const target = (y * width + x) * 4;
      rgba[target] = body[source + 2];
      rgba[target + 1] = body[source + 1];
      rgba[target + 2] = body[source];
      const masked = (body[maskRow + (x >> 3)] & (0x80 >> (x % 8))) !== 0;
      rgba[target + 3] = hasAlpha ? body[source + 3] : masked ? 0 : 255;
    }
  }
  return rgba;
}

/** Produces a single metadata-free PNG. Only bounded raster data ever reaches sharp. */
export async function decodeIconImage(body: Buffer, signal: AbortSignal): Promise<Buffer> {
  if (signal.aborted || body.length > MAX_BYTES) invalid();
  const format = iconImageFormat(body);
  if (!format) invalid();
  let raw: { width: number; height: number; channels: 4 } | undefined;
  if (format === "ico") {
    const frame = icoFrame(body);
    if (iconImageFormat(frame.body) === "png") {
      // Validate the embedded PNG dimensions before letting the raster decoder allocate.
      if (
        frame.body.length < 33 ||
        frame.body.readUInt32BE(8) !== 13 ||
        frame.body.subarray(12, 16).toString("latin1") !== "IHDR" ||
        frame.body.readUInt32BE(16) !== frame.width ||
        frame.body.readUInt32BE(20) !== frame.height
      ) {
        invalid();
      }
      body = frame.body;
    } else {
      body = dibPixels(frame);
      raw = { width: frame.width, height: frame.height, channels: 4 };
    }
  }
  const image = sharp(body, { raw, limitInputPixels: MAX_PIXELS, pages: 1, failOn: "warning" })
    .timeout({ seconds: 2 })
    .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png();
  let abort = () => {};
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      abort = () => {
        image.destroy();
        reject(new Error("Icon unavailable"));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else void image.toBuffer().then(resolve, reject);
    });
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

// One-off generator: renders the Zesume "Z" mark to icon16/48/128.png.
// Pure Node (zlib only). Supersampled 8x then box-downsampled for smooth edges.
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const ACCENT = [0x0a, 0x66, 0xc2]; // #0A66C2
const ACCENT2 = [0x09, 0x52, 0xa0]; // gradient end #0952A0
const WHITE = [255, 255, 255];

// Z glyph polygon in a 32x32 coordinate space (from Logo.jsx path).
const Z = [
  [9, 10], [23, 10], [23, 12.6], [13.2, 19.4], [23, 19.4],
  [23, 22], [9, 22], [9, 19.4], [18.8, 12.6], [9, 12.6],
];

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function renderRGBA(size) {
  const S = 8; // supersample factor
  const N = size * S;
  const acc = new Float32Array(size * size * 4);
  const radius = N * (8 / 32); // rx=8 on 32 viewBox

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // rounded-square background test
      const insideRect = roundedRect(x + 0.5, y + 0.5, N, N, radius);
      let r = 0, g = 0, b = 0, a = 0;
      if (insideRect) {
        // vertical gradient accent -> accent2
        const t = y / N;
        r = ACCENT[0] + (ACCENT2[0] - ACCENT[0]) * t;
        g = ACCENT[1] + (ACCENT2[1] - ACCENT[1]) * t;
        b = ACCENT[2] + (ACCENT2[2] - ACCENT[2]) * t;
        a = 255;
        // Z glyph in white (map pixel to 32-space)
        const zx = (x / N) * 32;
        const zy = (y / N) * 32;
        if (pointInPoly(zx, zy, Z)) {
          r = WHITE[0]; g = WHITE[1]; b = WHITE[2];
        }
      }
      // accumulate into downsampled cell
      const dx = (x / S) | 0;
      const dy = (y / S) | 0;
      const di = (dy * size + dx) * 4;
      acc[di] += r; acc[di + 1] += g; acc[di + 2] += b; acc[di + 3] += a;
    }
  }

  const out = Buffer.alloc(size * size * 4);
  const per = S * S;
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = Math.round(acc[i * 4] / per);
    out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / per);
    out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / per);
    out[i * 4 + 3] = Math.round(acc[i * 4 + 3] / per);
  }
  return out;
}

function roundedRect(px, py, w, h, r) {
  const x = Math.max(r - px, px - (w - r), 0);
  const y = Math.max(r - py, py - (h - r), 0);
  if (px < r && py < r) return Math.hypot(x, y) <= r; // TL
  if (px > w - r && py < r) return Math.hypot(x, y) <= r; // TR
  if (px < r && py > h - r) return Math.hypot(x, y) <= r; // BL
  if (px > w - r && py > h - r) return Math.hypot(x, y) <= r; // BR
  return true;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const dir = __dirname;
for (const size of [16, 48, 128]) {
  const png = encodePNG(size, renderRGBA(size));
  fs.writeFileSync(path.join(dir, `icon${size}.png`), png);
  console.log(`wrote icon${size}.png (${png.length} bytes)`);
}

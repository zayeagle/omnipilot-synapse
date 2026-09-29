// Deterministic PNG icon generation — no binary assets are committed to git.
//
// Motif: a rounded-square badge with a small knowledge-graph (3 nodes, 2 links),
// which reads as "capture into a connected system" at 16 px.
//
// Uses only node:zlib built-ins (CRC32 + zlib deflate) so the script has no dependencies.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'public');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const SUPERSAMPLE = 4;

function makeCanvas(size) {
  const n = size * SUPERSAMPLE;
  return { n, px: new Float32Array(n * n * 4) };
}

function blend(canvas, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= canvas.n || y >= canvas.n) return;
  const i = (y * canvas.n + x) * 4;
  const src = a;
  const dst = canvas.px[i + 3];
  const outA = src + dst * (1 - src);
  if (outA <= 0) return;
  canvas.px[i] = (r * src + canvas.px[i] * dst * (1 - src)) / outA;
  canvas.px[i + 1] = (g * src + canvas.px[i + 1] * dst * (1 - src)) / outA;
  canvas.px[i + 2] = (b * src + canvas.px[i + 2] * dst * (1 - src)) / outA;
  canvas.px[i + 3] = outA;
}

function fillRoundedRect(canvas, x0, y0, w, h, radius, color) {
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;
  const hw = w / 2;
  const hh = h / 2;
  const r = Math.min(radius, hw, hh);
  for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y += 1) {
    for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x += 1) {
      const dx = Math.max(Math.abs(x + 0.5 - cx) - (hw - r), 0);
      const dy = Math.max(Math.abs(y + 0.5 - cy) - (hh - r), 0);
      if (dx * dx + dy * dy <= r * r) blend(canvas, x, y, color);
    }
  }
}

function fillCircle(canvas, cx, cy, radius, color) {
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y += 1) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= radius * radius) blend(canvas, x, y, color);
    }
  }
}

function fillSegment(canvas, x1, y1, x2, y2, thickness, color) {
  const half = thickness / 2;
  const minX = Math.floor(Math.min(x1, x2) - half - 1);
  const maxX = Math.ceil(Math.max(x1, x2) + half + 1);
  const minY = Math.floor(Math.min(y1, y2) - half - 1);
  const maxY = Math.ceil(Math.max(y1, y2) + half + 1);
  const vx = x2 - x1;
  const vy = y2 - y1;
  const len2 = vx * vx + vy * vy || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5 - x1;
      const py = y + 0.5 - y1;
      let t = (px * vx + py * vy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = px - t * vx;
      const dy = py - t * vy;
      if (dx * dx + dy * dy <= half * half) blend(canvas, x, y, color);
    }
  }
}

function renderIcon(size) {
  const canvas = makeCanvas(size);
  const n = canvas.n;
  const s = size;
  const BG = [0x1f, 0x6f, 0xeb, 1];
  const FG = [0xff, 0xff, 0xff, 0.96];

  fillRoundedRect(canvas, 0, 0, n, n, s * 0.22 * SUPERSAMPLE, BG);

  const nodes = [
    [s * 0.3, s * 0.71],
    [s * 0.7, s * 0.71],
    [s * 0.5, s * 0.32],
  ].map(([x, y]) => [x * SUPERSAMPLE, y * SUPERSAMPLE]);

  const linkThickness = Math.max(s * 0.075, 0.9) * SUPERSAMPLE;
  fillSegment(canvas, nodes[0][0], nodes[0][1], nodes[2][0], nodes[2][1], linkThickness, FG);
  fillSegment(canvas, nodes[1][0], nodes[1][1], nodes[2][0], nodes[2][1], linkThickness, FG);
  fillSegment(canvas, nodes[0][0], nodes[0][1], nodes[1][0], nodes[1][1], linkThickness, FG);

  const nodeRadius = Math.max(s * 0.125, 1.4) * SUPERSAMPLE;
  for (const [x, y] of nodes) fillCircle(canvas, x, y, nodeRadius, FG);

  // Downsample with box filtering → antialiased RGBA output.
  const out = Buffer.alloc(size * size * 4);
  const factor = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const i = ((y * SUPERSAMPLE + sy) * n + (x * SUPERSAMPLE + sx)) * 4;
          const alpha = canvas.px[i + 3];
          r += canvas.px[i] * alpha;
          g += canvas.px[i + 1] * alpha;
          b += canvas.px[i + 2] * alpha;
          a += alpha;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / factor) * 255);
    }
  }
  return out;
}

const SIZES = [16, 32, 48, 96, 128];

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(size, size, renderIcon(size));
  writeFileSync(join(OUT_DIR, `icon-${size}.png`), png);
}
writeFileSync(join(OUT_DIR, 'icon.png'), encodePng(128, 128, renderIcon(128)));

console.log(`icons: wrote ${SIZES.length + 1} files to ${OUT_DIR}`);

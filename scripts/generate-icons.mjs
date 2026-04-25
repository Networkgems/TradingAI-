// Generates minimal solid-color PNG icons for PWA without external dependencies.
// Purple (#7c3aed) background to match the app's trading theme.
import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'apps', 'desktop', 'public');

mkdirSync(PUBLIC_DIR, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// Draw a simple chart line on the icon so it looks like a trading app
function createTradingPNG(size) {
  const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData.writeUInt8(8, 8);  // bit depth
  ihdrData.writeUInt8(2, 9);  // RGB
  ihdrData.writeUInt8(0, 10); // deflate
  ihdrData.writeUInt8(0, 11); // no filter
  ihdrData.writeUInt8(0, 12); // no interlace

  // Pixel grid: background purple, white chart line and bar outlines
  const BG = [0x7c, 0x3a, 0xed];   // #7c3aed purple
  const FG = [0xff, 0xff, 0xff];   // white

  const pixels = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => [...BG])
  );

  // Draw a simple 3-step rising line in the bottom-center area
  const pad = Math.round(size * 0.15);
  const chartW = size - pad * 2;
  const chartH = Math.round(size * 0.45);
  const baseY = size - pad - 1;

  // Y positions for 4 key points (ascending line)
  const points = [
    [pad, baseY],
    [pad + Math.round(chartW * 0.33), baseY - Math.round(chartH * 0.35)],
    [pad + Math.round(chartW * 0.66), baseY - Math.round(chartH * 0.6)],
    [pad + chartW, baseY - chartH],
  ];

  const lineThickness = Math.max(2, Math.round(size * 0.025));

  // Draw line segments between points
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 4;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = Math.round(x0 + (x1 - x0) * t);
      const py = Math.round(y0 + (y1 - y0) * t);
      for (let dy = -lineThickness; dy <= lineThickness; dy++) {
        for (let dx = -lineThickness; dx <= lineThickness; dx++) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
            pixels[ny][nx] = [...FG];
          }
        }
      }
    }
  }

  // Draw small dot at each point
  const dotR = Math.max(3, Math.round(size * 0.04));
  for (const [px, py] of points) {
    for (let dy = -dotR; dy <= dotR; dy++) {
      for (let dx = -dotR; dx <= dotR; dx++) {
        if (dx * dx + dy * dy <= dotR * dotR) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
            pixels[ny][nx] = [...FG];
          }
        }
      }
    }
  }

  const rawData = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    rawData[y * (1 + size * 3)] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const off = y * (1 + size * 3) + 1 + x * 3;
      rawData[off] = pixels[y][x][0];
      rawData[off + 1] = pixels[y][x][1];
      rawData[off + 2] = pixels[y][x][2];
    }
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdrData),
    chunk('IDAT', deflateSync(rawData)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync(join(PUBLIC_DIR, 'icon-192.png'), createTradingPNG(192));
writeFileSync(join(PUBLIC_DIR, 'icon-512.png'), createTradingPNG(512));
writeFileSync(join(PUBLIC_DIR, 'apple-touch-icon.png'), createTradingPNG(180));
console.log('Icons written to apps/desktop/public/');

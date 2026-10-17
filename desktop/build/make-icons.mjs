// Gera os ícones PNG do app e da bandeja (sem dependências).
import zlib from "node:zlib";
import fs from "node:fs";
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // 4x supersampling para bordas suaves
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const p = pixel((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size);
      acc = acc.map((v, i) => v + p[i] * (i < 3 ? p[3] / 255 : 1));
    }
    const a = acc[3] / 16, i = y * (size * 4 + 1) + 1 + x * 4;
    raw[i] = a ? acc[0] / (acc[3] / 255) : 0; raw[i + 1] = a ? acc[1] / (acc[3] / 255) : 0; raw[i + 2] = a ? acc[2] / (acc[3] / 255) : 0; raw[i + 3] = a;
  }
  const h = Buffer.alloc(13); h.writeUInt32BE(size, 0); h.writeUInt32BE(size, 4); h[8] = 8; h[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", h), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const rounded = (u, v, r) => { const dx = Math.max(r - u, 0, u - (1 - r)), dy = Math.max(r - v, 0, v - (1 - r)); return Math.hypot(dx, dy) <= r; };
const d = (u, v) => Math.hypot(u - 0.5, v - 0.5);
const appIcon = (u, v) => {
  const m = 0.06; // margem
  const uu = (u - m) / (1 - 2 * m), vv = (v - m) / (1 - 2 * m);
  if (uu < 0 || uu > 1 || vv < 0 || vv > 1 || !rounded(uu, vv, 0.22)) return [0, 0, 0, 0];
  if (d(u, v) <= 0.17) return [229, 57, 53, 255];
  if (d(u, v) <= 0.245) return [255, 255, 255, 255];
  return [79, 70, 229, 255];
};
const trayTemplate = (u, v) => (d(u, v) <= 0.2 ? [0, 0, 0, 255] : d(u, v) <= 0.32 ? [0, 0, 0, 0] : d(u, v) <= 0.44 ? [0, 0, 0, 255] : [0, 0, 0, 0]);
const trayColor = (u, v) => (d(u, v) <= 0.2 ? [229, 57, 53, 255] : d(u, v) <= 0.3 ? [255, 255, 255, 255] : d(u, v) <= 0.46 ? [79, 70, 229, 255] : [0, 0, 0, 0]);
const trayRec = (u, v) => (d(u, v) <= 0.4 ? [229, 57, 53, 255] : [0, 0, 0, 0]);
fs.writeFileSync("build/icon.png", png(1024, appIcon));
fs.writeFileSync("assets/icon.png", png(256, appIcon));
for (const [name, fn] of [["trayTemplate", trayTemplate], ["tray", trayColor], ["trayRecording", trayRec]]) {
  fs.writeFileSync(`assets/${name}.png`, png(16, fn));
  fs.writeFileSync(`assets/${name}@2x.png`, png(32, fn));
}

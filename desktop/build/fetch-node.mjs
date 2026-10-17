// Baixa o Node.js oficial que vai dentro do app (o servidor local roda nele: o
// sherpa-onnx usa "external buffers", que o V8 do Electron proíbe).
// Uso: node build/fetch-node.mjs mac-arm64 mac-x64 linux-x64 …   (padrão: o sistema atual)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "24.11.1"; // LTS; mesma série do Node do Electron 44
const here = path.dirname(fileURLToPath(import.meta.url));
const OS = { mac: "darwin", win: "win", linux: "linux" };
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [`${{ darwin: "mac", win32: "win", linux: "linux" }[process.platform]}-${process.arch}`];

for (const target of targets) {
  const [osName, arch] = target.split("-");
  const dest = path.join(here, "node", target);
  const bin = path.join(dest, osName === "win" ? "node.exe" : "node");
  if (fs.existsSync(bin)) {
    console.log(`já existe: ${bin}`);
    continue;
  }
  const base = `node-v${VERSION}-${OS[osName]}-${arch}`;
  const file = osName === "win" ? `${base}.zip` : osName === "linux" ? `${base}.tar.xz` : `${base}.tar.gz`;
  const url = `https://nodejs.org/dist/v${VERSION}/${file}`;
  console.log(`baixando ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download falhou: ${res.status} ${url}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "node-"));
  const archive = path.join(tmp, file);
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  const member = osName === "win" ? `${base}/node.exe` : `${base}/bin/node`;
  // No Windows usa o tar.exe do sistema (bsdtar, abre .zip). No bash do GitHub Actions
  // o primeiro "tar" do PATH é o GNU tar do Git, que não abre .zip.
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xf", archive, "-C", tmp, member]);
  fs.mkdirSync(dest, { recursive: true });
  // Copia (não renomeia): no Windows do GitHub a pasta temporária fica em C: e o
  // projeto em D:, e rename entre discos falha (EXDEV).
  fs.copyFileSync(path.join(tmp, member), bin);
  fs.chmodSync(bin, 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`ok: ${bin}`);
}

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
  // bsdtar/GNU tar extraem .tar.gz, .tar.xz e .zip (o tar do Windows 10+ é bsdtar).
  const member = osName === "win" ? `${base}/node.exe` : `${base}/bin/node`;
  execFileSync("tar", ["-xf", archive, "-C", tmp, member]);
  fs.mkdirSync(dest, { recursive: true });
  fs.renameSync(path.join(tmp, member), bin);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`ok: ${bin}`);
}

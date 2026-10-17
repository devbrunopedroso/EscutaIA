// Empacota o servidor (TypeScript em ../server) e o site (../web) para dentro do app.
// As dependências (fastify, PGlite, sherpa-onnx, ffmpeg-static…) ficam em node_modules
// do próprio app, instaladas para o sistema em que o instalador é gerado.
import { build } from "esbuild";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "server");
fs.rmSync(out, { recursive: true, force: true });

await build({
  entryPoints: { server: "../server/src/index.ts", compute: "../server/src/compute.ts" },
  absWorkingDir: root,
  outdir: out,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  logLevel: "warning",
});
fs.copyFileSync(path.join(root, "../server/src/schema.sql"), path.join(out, "schema.sql"));

console.log("building web…");
execSync("npm run build", { cwd: path.join(root, "../web"), stdio: "inherit" });
fs.rmSync(path.join(root, "web"), { recursive: true, force: true });
fs.cpSync(path.join(root, "../web/dist"), path.join(root, "web"), { recursive: true });
console.log("servidor e site empacotados em desktop/server e desktop/web");

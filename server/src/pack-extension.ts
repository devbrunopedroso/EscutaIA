// Gera o zip para enviar à Chrome Web Store, já apontando para o seu servidor.
// Uso: node src/pack-extension.ts https://escutaia.suaempresa.com
import fs from "node:fs/promises";
import path from "node:path";
import { buildExtensionZip, extensionInfo } from "./extension.ts";

const origin = process.argv[2]?.replace(/\/+$/, "");
if (!origin || !/^https:\/\//.test(origin)) {
  console.error("Uso: node src/pack-extension.ts https://SEU-SERVIDOR (a loja exige HTTPS)");
  process.exit(1);
}
const { version } = await extensionInfo();
const out = path.resolve(`../dist/escutaia-extension-${version}-store.zip`);
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, await buildExtensionZip(origin, ""));
console.log(`Gerado ${out}\nEnvie em https://chrome.google.com/webstore/devconsole (veja README → "Publicar na Chrome Web Store").`);

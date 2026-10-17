// Gera o zip da extensão configurado para este servidor: endereço já preenchido e
// content script que deixa o site conectar a conta com um clique.
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyRequest } from "fastify";
import { strToU8, zipSync } from "fflate";
import { config } from "./config.ts";

export function publicOrigin(req: FastifyRequest): string {
  return config.publicUrl ?? `${req.protocol}://${req.host}`;
}

async function readTree(dir: string, base = dir): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await readTree(full, base));
    else out[path.relative(base, full)] = await fs.readFile(full);
  }
  return out;
}

export async function extensionInfo() {
  const manifest = JSON.parse(await fs.readFile(path.join(config.extensionDir, "manifest.json"), "utf8"));
  return { version: manifest.version as string };
}

// prefix: pasta dentro do zip. O download do site usa "escutaia-extension/" (o usuário
// descompacta e escolhe a pasta); a Chrome Web Store exige o manifest na raiz ("").
export async function buildExtensionZip(origin: string, prefix = "escutaia-extension/"): Promise<Uint8Array> {
  const files = await readTree(config.extensionDir);
  const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString("utf8"));
  const url = new URL(origin);
  // Padrões de match não aceitam porta; hostname cobre todas as portas desse host.
  manifest.content_scripts = [
    ...(manifest.content_scripts ?? []),
    { matches: [`${url.protocol}//${url.hostname}/*`], js: ["connect.js"], run_at: "document_start" },
  ];
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  files["config.json"] = strToU8(JSON.stringify({ server: origin }, null, 2));
  const zipped: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(files)) zipped[`${prefix}${name}`] = data;
  return zipSync(zipped, { level: 9 });
}

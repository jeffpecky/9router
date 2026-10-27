#!/usr/bin/env node
// Compares real Bun's client fingerprint against this repo's opencodeTlsFetch
// (wreq-js + OPENCODE_TLS_PROFILE), direct and through a proxy. Exit 1 on
// mismatch. Usage:
//   node scripts/opencode-tls-harness.mjs [--bun <bunExe>] [--proxy <url>] [--url <peetUrl>]
// Ground truth as of 2026-10-27 (Bun 1.3.14):
//   ja4 t13d1714h1_5b57614c22b0_43ade6aba3df  ja3_hash d871d02cecbde59abbf8f4806134addf
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const url = opt("--url", "https://tls.peet.ws/api/all");
const bunExe = opt("--bun", "bun");
const proxyUrl = opt("--proxy", null);

const grab = j => ({ ja3: j.tls?.ja3, ja3_hash: j.tls?.ja3_hash, ja4: j.tls?.ja4 });

const bunJson = grab(JSON.parse(execFileSync(bunExe, ["-e", `
  const r = await fetch(${JSON.stringify(url)}, { headers: { "user-agent": "opencode-tls-harness" } });
  process.stdout.write(JSON.stringify(await r.json()));
`])));
const { opencodeTlsFetch } = await import(new URL("../open-sse/services/opencodeTlsClient.js", import.meta.url).href);
const wreqRes = await opencodeTlsFetch(url, { headers: { "user-agent": "opencode-tls-harness" } }, proxyUrl ? { proxyUrl } : {});
const wreqJson = grab(await wreqRes.json());

for (const [label, a, b] of [
  ["ja4", bunJson.ja4, wreqJson.ja4],
  ["ja3_hash", bunJson.ja3_hash, wreqJson.ja3_hash],
]) {
  const ok = a === b ? "MATCH" : "DIFF";
  console.log(`${label.padEnd(9)} ${ok}  bun=${a}  wreq=${b}`);
}
if (process.argv.includes("--verbose")) console.log({ bun: bunJson, wreq: wreqJson });
process.exit(bunJson.ja4 === wreqJson.ja4 && bunJson.ja3_hash === wreqJson.ja3_hash ? 0 : 1);

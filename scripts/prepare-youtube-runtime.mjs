import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
if (process.platform !== "win32") process.exit(0);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "src-tauri", "resources", "youtube");
await fs.mkdir(directory, { recursive: true });
const binaries = [
  { name: "yt-dlp.exe", version: "2026.10.26", url: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe", sha256: "f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d" },
];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
async function writeText(file, text) { if (await fs.readFile(file,"utf8").catch(() => null) !== text) await fs.writeFile(file,text); }
for (const binary of binaries) {
  const destination = path.join(directory, binary.name);
  const existing = await fs.readFile(destination).catch(() => null);
  if (existing && sha256(existing) === binary.sha256) continue;
  console.log(`Preparing verified YouTube audio helper: ${binary.name} ${binary.version}`);
  const response = await fetch(binary.url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error(`Could not download ${binary.name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== binary.sha256) throw Error(`Checksum mismatch for ${binary.name}; refusing to use the download.`);
  await fs.writeFile(destination, bytes);
}
for (const [name, url] of [
  ["yt-dlp-LICENSE.txt", "https://raw.githubusercontent.com/yt-dlp/yt-dlp/2026.10.26/LICENSE"],
  ["yt-dlp-THIRD-PARTY.txt", "https://raw.githubusercontent.com/yt-dlp/yt-dlp/2026.10.26/THIRD_PARTY_LICENSES.txt"],
  ["GPL-3.0.txt", "https://raw.githubusercontent.com/gcc-mirror/gcc/master/COPYING3"],
]) {
  const destination = path.join(directory, name);
  if (await fs.stat(destination).catch(() => null)) continue;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error(`Could not obtain third-party notice ${name}: ${response.status}`);
  await fs.writeFile(destination, await response.text());
}
await writeText(path.join(directory, "NOTICE.txt"), "SoundSphere YouTube audio runtime\n\nyt-dlp 2026.10.26: https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26\nOfficial standalone executable, GPL-3.0-or-later combined distribution. Source, build instructions and third-party notices are available at the upstream release. See bundled license files.\n\nThis is an independent command-line program. SoundSphere invokes it without a shell, browser cookies, user configuration, remote components or an external JavaScript runtime.\n");
await writeText(path.join(directory, "manifest.json"), JSON.stringify(binaries, null, 2));
console.log("YouTube audio runtime verified.");

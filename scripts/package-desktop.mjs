import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform === "win32") {
  const destination = path.join(root, "SoundSphere.exe");
  copyFileSync(path.join(root, "src-tauri", "target", "release", "soundsphere.exe"), destination);
  console.log(`Standalone application ready: ${destination}`);
}

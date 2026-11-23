// Run against a development WebView started with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
// and SOUNDSPHERE_TEST_DATA_DIR=<project>/test-artifacts/app-data. No provider or IPC mocks are used.
import { chromium, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "test-artifacts"); fs.mkdirSync(artifacts, { recursive: true });
function silence(name) {
  const seconds = 12, rate = 22050, length = seconds * rate * 2;
  const b = Buffer.alloc(44 + length); b.write("RIFF"); b.writeUInt32LE(36 + length, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(length, 40);
  const file = path.join(artifacts, `${name}.wav`); fs.writeFileSync(file, b); return file;
}
const cdp = process.env.SOUNDSPHERE_CDP_URL ?? "http://127.0.0.1:9223";
for (let attempt = 0; attempt < 30; attempt++) {
  try { const response = await fetch(`${cdp}/json/list`); const list = await response.json(); if (list.some(p => p.url?.includes("localhost:5173"))) break; } catch {}
  await new Promise(resolve => setTimeout(resolve, 1000));
}
const browser = await chromium.connectOverCDP(cdp);
let page;
const results = [], errors = [];
try {
  page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes("localhost:5173"));
  if (!page) throw new Error("SoundSphere development WebView was not found.");
  page.setDefaultTimeout(15000); page.on("pageerror", e => errors.push(String(e)));
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const nav = async name => { await page.locator(".sidebar").getByRole("button", { name, exact: true }).click(); await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible(); };
  const pass = (name, details = {}) => { results.push({ name, status: "passed", ...details }); console.log(`PASS ${name}`, JSON.stringify(details)); };
  const assertPlaying = async () => page.waitForFunction(() => { const a = document.querySelector("audio"); return !!a && !a.paused && !a.error && a.currentTime > .3; }, null, { timeout: 25000 });
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const runtime = await invoke("runtime_info");
  if (!runtime.testMode) throw new Error("Refusing to run fixtures against a non-test library. Set SOUNDSPHERE_TEST_DATA_DIR when starting tauri dev.");
  const before = await invoke("get_library");
  for (const t of before.tracks.filter(t => t.title.startsWith("QA "))) await invoke("library_action", { action: "remove", id: t.id });
  for (const p of before.playlists.filter(p => p.name === "QA listening")) await invoke("library_action", { action: "playlist_delete", id: p.id });
  await expect(page.getByText("Desktop engine unavailable", { exact: true })).toHaveCount(0);
  pass("desktop engine loads without a blank screen");

  const importResult = await invoke("import_audio", { paths: [silence("QA Local One"), silence("QA Local Two")] });
  expect(importResult.imported).toBe(2); expect(importResult.errors).toHaveLength(0);
  let state = await invoke("get_library");
  expect(state.tracks.filter(t => t.title.startsWith("QA Local"))).toHaveLength(2);
  await page.reload(); await nav("Your Library");
  const first = state.tracks.find(t => t.title === "QA Local One");
  await page.getByRole("button", { name: "Play QA Local One now", exact: true }).click();
  await assertPlaying(); pass("native local import and real audio decoding");
  await page.getByRole("button", { name: "Pause playback", exact: true }).click();
  expect(await page.locator("audio").evaluate(a => a.paused)).toBe(true);
  const seek = page.getByRole("slider", { name: "Seek playback", exact: true }); await seek.focus(); await seek.press("End");
  expect(await page.locator("audio").evaluate(a => a.currentTime)).toBeGreaterThan(10);
  await page.getByRole("button", { name: "Next track", exact: true }).click(); await assertPlaying();
  await expect(page.locator(".now-playing b")).toHaveText("QA Local Two");
  await page.getByRole("button", { name: "Pause playback", exact: true }).click();
  pass("pause, seeking and next-track queue");
  await page.getByRole("button", { name: "Favourite QA Local One", exact: true }).click();
  await nav("Favourites"); await expect(page.locator(".track-row")).toHaveCount(1);
  await nav("Playlists"); await page.getByRole("button", { name: "New playlist", exact: true }).click();
  await page.getByLabel("Playlist name", { exact: true }).fill("QA listening");
  await page.getByRole("button", { name: "Create playlist", exact: true }).click();
  state = await invoke("get_library"); const playlist = state.playlists.find(p => p.name === "QA listening"); expect(playlist).toBeTruthy();
  await nav("Your Library"); await page.getByRole("combobox", { name: "Add QA Local One to playlist", exact: true }).selectOption(playlist.id);
  await nav("Playlists"); await page.locator(".playlist-tabs").getByRole("button", { name: /QA listening/ }).click();
  await expect(page.locator(".track-row")).toHaveCount(1);
  await page.reload();
  state = await invoke("get_library"); expect(state.favorites).toContain(first.id); expect(state.playlists.find(p => p.id === playlist.id).trackIds).toContain(first.id);
  pass("favourites and playlists persist across frontend reload");

  const good = first.sources[0];
  const fallback = { ...first, id: "qa-fallback", title: "QA fallback verification", sources: [{ ...good, id: "qa-missing", label: "Missing QA file", localPath: path.join(artifacts, "does-not-exist.wav") }, { ...good, id: "qa-working", label: "Working QA file" }] };
  await invoke("library_action", { action: "save", track: fallback });
  await page.reload(); await nav("Your Library");
  await page.getByRole("button", { name: "Play QA fallback verification now", exact: true }).click(); await assertPlaying();
  await expect(page.locator(".source-card.selected")).toContainText("Working QA file");
  await expect(page.locator(".source-card").filter({ hasText: "Missing QA file" })).toContainText("failed");
  await page.locator(".source-card").filter({ hasText: "Working QA file" }).click(); await assertPlaying();
  state = await invoke("get_library"); expect(state.preferences["qa-fallback"]).toBe("qa-working");
  pass("failed-source fallback and remembered manual source preference");
  await page.getByRole("button", { name: "Pause playback", exact: true }).click();

  await nav("Discover"); await page.getByRole("textbox", { name: "Search audio", exact: true }).fill("piano");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".provider-status.searching")).toHaveCount(0, { timeout: 45000 });
  await expect(page.locator(".track-row").first()).toBeVisible();
  await expect(page.locator(".provider-status").filter({ hasText: "Jamendo" })).toContainText("client ID");
  const providerStatus = await page.locator(".provider-grid").innerText();
  expect(providerStatus).toContain("Audius"); expect(providerStatus).toContain("Internet Archive");
  pass("parallel live-provider search and visible missing-credential error", { providerStatus });
  await page.screenshot({ path: path.join(artifacts, "desktop-search.png"), fullPage: true });

  await nav("Quran / Tilawat"); await expect(page.getByRole("combobox", { name: "Surah", exact: true })).toBeVisible({ timeout: 20000 });
  expect(await page.getByRole("combobox", { name: "Surah", exact: true }).locator("option").count()).toBe(114);
  await page.getByRole("combobox", { name: "Listen by", exact: true }).selectOption("surah");
  await page.getByRole("combobox", { name: "Qari", exact: true }).selectOption("7");
  await page.getByRole("button", { name: "Load recitation", exact: true }).click();
  await expect(page.locator(".track-row")).toHaveCount(1, { timeout: 25000 });
  await page.getByRole("slider", { name: "Volume", exact: true }).focus(); await page.getByRole("slider", { name: "Volume", exact: true }).press("Home");
  const quran = await invoke("quran_tracks", { chapter: 1, reciter: 7, mode: "surah", ayah: 0, juz: 1 });
  await page.getByRole("button", { name: `Play ${quran[0].title} now`, exact: true }).click(); await assertPlaying();
  pass("Quran Surah catalog and live audio playback", { title: quran[0].title });
  await page.getByRole("button", { name: "Pause playback", exact: true }).click();
  await page.getByRole("button", { name: `Download ${quran[0].title}`, exact: true }).click();
  await nav("Downloads");
  await expect(page.locator(".download-row").filter({ hasText: quran[0].title }).first()).toContainText("completed", { timeout: 45000 });
  state = await invoke("get_library"); const completed = state.downloads.find(d => d.trackId === quran[0].id && d.status === "completed");
  expect(completed.bytes).toBeGreaterThan(1000); expect(fs.existsSync(completed.path)).toBe(true);
  await nav("Your Library"); await page.getByRole("button", { name: `Play ${quran[0].title} now`, exact: true }).click(); await assertPlaying();
  await expect(page.locator(".source-card.selected")).toContainText("Offline download");
  pass("permitted download queue and local playback of downloaded audio", { bytes: completed.bytes });
  await page.getByRole("button", { name: "Pause playback", exact: true }).click();

  const queueReport = await page.evaluate(async track => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const first = { ...track, id: "qa-queue-one", title: "QA download one" };
    const second = { ...track, id: "qa-queue-two", title: "QA download two" };
    for (const t of [first, second]) await invoke("library_action", { action: "save", track: t });
    const pending = [first, second].map(t => invoke("download_track", { trackId: t.id, sourceId: t.sources[0].id }));
    let job;
    for (let i = 0; i < 100; i++) {
      const state = await invoke("get_library"); job = state.downloads.findLast(d => d.trackId === second.id);
      if (job) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!job) throw new Error("Queued download did not appear");
    const queuedStatus = job.status;
    await invoke("library_action", { action: "cancel_download", id: job.id });
    const finished = await Promise.all(pending);
    const retried = await invoke("download_track", { trackId: second.id, sourceId: second.sources[0].id });
    return { queuedStatus, statuses: finished.map(d => d.status), retry: retried.status };
  }, quran[0]);
  expect(queueReport.queuedStatus).toBe("queued"); expect(queueReport.statuses).toEqual(["completed", "cancelled"]); expect(queueReport.retry).toBe("completed");
  pass("sequential download queue, cancellation and retry", queueReport);

  await nav("Quran / Tilawat"); await page.getByRole("combobox", { name: "Listen by", exact: true }).selectOption("ayah");
  await page.getByLabel("Ayah number", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Load recitation", exact: true }).click();
  await expect(page.locator(".track-row")).toHaveCount(1, { timeout: 25000 });
  await page.getByRole("button", { name: "Play Ayah 1:1 now", exact: true }).click(); await assertPlaying();
  await page.locator(".source-card").filter({ hasText: "EveryAyah backup" }).click(); await assertPlaying();
  await expect(page.locator(".source-card.selected")).toContainText("EveryAyah backup");
  pass("Ayah playback and manual switch to real EveryAyah audio");
  await page.getByRole("button", { name: "Pause playback", exact: true }).click();
  await page.screenshot({ path: path.join(artifacts, "desktop-quran.png"), fullPage: true });
  expect(errors).toEqual([]); pass("no uncaught frontend exceptions");
} catch (error) {
  console.error(error); results.push({ name: "desktop verification", status: "failed", error: String(error) });
  if (page) { await page.screenshot({ path: path.join(artifacts, "desktop-failure.png"), fullPage: true }).catch(() => {}); console.log((await page.locator("body").innerText().catch(() => "")).slice(-5000)); }
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(artifacts, "verification.json"), JSON.stringify({ results, errors }, null, 2));
  await browser.close();
}

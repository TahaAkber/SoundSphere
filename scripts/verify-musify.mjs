import { chromium, expect } from "@playwright/test";
import fs from "node:fs";
const cdp = process.env.SOUNDSPHERE_CDP_URL ?? "http://127.0.0.1:9223";
const browser = await chromium.connectOverCDP(cdp);
let page; const checks = []; const exceptions = [];
try {
  page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes("localhost:5173"));
  if (!page) throw Error("Start the isolated Tauri development app first.");
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  if (!(await invoke("runtime_info")).testMode) throw Error("Refusing to change a normal user library.");
  page.on("pageerror", e => exceptions.push(String(e)));
  const pass = (name, details = {}) => { checks.push({ name, ...details }); console.log("PASS", name, JSON.stringify(details)); };
  const nav = name => page.locator(".sidebar").getByRole("button", { name, exact: true }).click();
  await nav("Musify links");
  await expect(page.locator(".musify-card").first()).toBeVisible({ timeout: 25000 });
  const catalog = await invoke("musify_catalog");
  expect(catalog.collections.filter(c => c.kind === "playlist").length).toBeGreaterThanOrEqual(77);
  expect(catalog.collections.filter(c => c.kind === "album").length).toBeGreaterThanOrEqual(117);
  expect(catalog.radio).toHaveLength(20);
  pass("upstream Musify link catalog", { collections: catalog.collections.length, radio: catalog.radio.length });
  await page.locator(".catalog-tabs").getByRole("button", { name: /Albums/ }).click();
  await page.getByRole("textbox", { name: "Filter Musify links", exact: true }).fill("Starboy");
  await expect(page.locator(".musify-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Save Starboy - The Weeknd link", exact: true }).click();
  await expect.poll(async () => (await invoke("get_library")).tracks.some(t => t.title === "Starboy - The Weeknd" && t.sources[0].youtubeKind === "playlist")).toBe(true);
  let library = await invoke("get_library");
  pass("album filtering and persistent playlist-link save");
  await page.screenshot({ path: "test-artifacts/musify-catalog.png", fullPage: true });

  await page.locator(".catalog-tabs").getByRole("button", { name: /Radio/ }).click();
  const volume = page.getByRole("slider", { name: "Volume", exact: true }); await volume.focus(); await volume.press("Home");
  let radioPlayed;
  for (const station of catalog.radio.slice(0, 3)) {
    const card = page.locator(".musify-card").filter({ has: page.getByRole("heading", { name: station.title, exact: true }) });
    await card.getByRole("button", { name: "Listen", exact: true }).click();
    await page.waitForFunction(() => { const a = document.querySelector("audio"); return (a && !a.paused && !a.error && a.currentTime > .4) || document.querySelector('[role="alert"]')?.textContent?.includes("All sources failed"); }, null, { timeout: 22000 });
    if (await page.locator("audio").evaluate(a => !a.paused && !a.error && a.currentTime > .3)) { radioPlayed = station.title; break; }
  }
  expect(radioPlayed).toBeTruthy(); await page.getByRole("button", { name: "Pause playback", exact: true }).click();
  pass("live Musify radio URL playback", { station: radioPlayed });

  const found = await invoke("search_provider", { provider: "youtube", query: "atif aslam tajdar e haram" });
  expect(found.error).toBeNull(); expect(found.tracks.length).toBeGreaterThan(0);
  expect(found.tracks.some(t => t.sources[0].youtubeId === "a18py61_F_w")).toBe(true);
  expect(found.tracks.every(t => !t.sources[0].downloadable)).toBe(true);
  pass("YouTube search returns public song links", { results: found.tracks.length });
  await page.getByRole("textbox", { name: "YouTube song or playlist link", exact: true }).fill("https://youtu.be/a18py61_F_w");
  await page.getByRole("button", { name: "Add & play", exact: true }).click();
  await expect(page.locator(".source-card").filter({hasText:"YouTube video"})).toBeVisible({timeout:20000});
  await page.locator(".source-card").filter({hasText:"YouTube video"}).click();
  await expect(page.locator(".youtube-frame video")).toBeVisible({ timeout: 25000 });
  await expect(page.locator(".youtube-panel h2")).toContainText("Tajdar-e-Haram");
  const video = page.locator(".youtube-frame video");
  await expect.poll(async () => video.evaluate(a => !a.paused && !a.error && a.currentTime > .4 && a.videoWidth > 0), { timeout: 60000 }).toBe(true);
  expect(await page.locator("audio").evaluate(a => a.paused)).toBe(false);
  await expect(page.getByRole("button", { name: "Pause playback", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause playback", exact: true }).click();
  await expect.poll(() => video.evaluate(a => a.paused)).toBe(true);
  const playerSize = await video.evaluate(e => ({ width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height }));
  const embedSize = await page.locator(".youtube-frame").boundingBox();
  expect(playerSize.width).toBeGreaterThan(embedSize.width * .9); expect(playerSize.height).toBeGreaterThanOrEqual(200);
  library = await invoke("get_library");
  expect(library.tracks.some(t => t.sources.some(s => s.youtubeId === "a18py61_F_w"))).toBe(true);
  await expect(page.locator("iframe")).toHaveCount(0);
  pass("imported YouTube video plays natively and pauses from app controls");
  await page.locator(".youtube-panel").screenshot({ path: "test-artifacts/musify-youtube.png" });
  const selectedTrack = library.tracks.find(t => t.sources.some(s => s.youtubeId === "a18py61_F_w"));
  const audioSource = selectedTrack.sources.find(s => s.provider === "youtube_audio");
  if(audioSource) await invoke("library_action",{action:"preference",id:selectedTrack.id,name:audioSource.id});
  expect(exceptions).toHaveLength(0);
} catch (e) {
  console.error(e); process.exitCode = 1;
  if (page) { await page.screenshot({ path: "test-artifacts/musify-failure.png", fullPage: true }).catch(() => {}); console.log((await page.locator("body").innerText()).slice(-5000)); }
} finally {
  fs.writeFileSync("test-artifacts/musify-verification.json", JSON.stringify({ checks, exceptions }, null, 2));
  await browser.close();
}

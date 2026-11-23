import { chromium, expect } from "@playwright/test";
import fs from "node:fs";
const browser = await chromium.connectOverCDP(process.env.SOUNDSPHERE_CDP_URL ?? "http://127.0.0.1:9223");
let page; const checks = []; const embeds = [];
try {
  page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes("localhost:5173"));
  if (!page) throw Error("Start an isolated development app.");
  const invoke = (command, args = {}) => page.evaluate(({command,args}) => window.__TAURI_INTERNALS__.invoke(command,args), {command,args});
  if (!(await invoke("runtime_info")).testMode) throw Error("Refusing to write fixtures into the normal library.");
  const saved = (await invoke("get_library")).tracks.find(t=>t.sources.some(s=>s.youtubeId==="a18py61_F_w"));
  if(saved) { const audio=saved.sources.find(s=>s.provider==="youtube_audio"); if(audio) await invoke("library_action",{action:"preference",id:saved.id,name:audio.id}); }
  await page.reload(); await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__); await page.bringToFront();
  page.on("request", request => { if (/youtube\.com\/(embed|iframe_api)/.test(request.url())) embeds.push(request.url().split("?")[0]); });
  const pass = (name, data = {}) => { checks.push({ name, ...data }); console.log("PASS",name,JSON.stringify(data)); };
  await page.locator(".sidebar").getByRole("button",{name:"Musify links",exact:true}).click();
  await page.getByRole("textbox",{name:"YouTube song or playlist link",exact:true}).fill("https://youtu.be/a18py61_F_w");
  const volume = page.getByRole("slider",{name:"Volume",exact:true}); await volume.focus(); await volume.press("Home");
  await page.getByRole("button",{name:"Add & play",exact:true}).click();
  await expect(page.locator(".source-card.selected")).toContainText("YouTube audio",{timeout:20000});
  await page.waitForFunction(() => { const a=document.querySelector("audio"); return a && !a.paused && !a.error && a.currentTime>.5; },null,{timeout:60000});
  expect(await page.locator("audio").evaluate(a=>new URL(a.src).hostname.endsWith(".googlevideo.com"))).toBe(true);
  await expect(page.locator(".youtube-frame iframe")).toHaveCount(0); expect(embeds).toHaveLength(0);
  const info=await page.locator("audio").evaluate(a=>({duration:a.duration,time:a.currentTime,paused:a.paused}));
  pass("Tajdar-e-Haram plays as native audio without loading the YouTube video/ad player",info);
  await page.getByRole("button",{name:"Pause playback",exact:true}).click(); expect(await page.locator("audio").evaluate(a=>a.paused)).toBe(true);
  const seek=page.getByRole("slider",{name:"Seek playback",exact:true}); await seek.focus(); await seek.press("PageUp");
  expect(await page.locator("audio").evaluate(a=>a.currentTime)).toBeGreaterThan(30);
  await page.getByRole("button",{name:"Start playback",exact:true}).click();
  await page.waitForFunction(()=>{const a=document.querySelector("audio");return a&&!a.paused&&a.currentTime>30;});
  await page.getByRole("button",{name:"Pause playback",exact:true}).click();
  pass("native pause, seek and resume");
  await page.screenshot({path:"test-artifacts/youtube-native-audio.png"});

  const catalog=await invoke("musify_catalog"); const collection=catalog.collections.find(c=>c.title==="Starboy - The Weeknd");
  if(!collection)throw Error("Reference playlist is unavailable upstream");
  const playlist=await invoke("musify_collection",{collectionId:collection.id});
  const queue=await invoke("youtube_playlist",{trackId:playlist.id});
  expect(queue.tracks.length).toBeGreaterThan(0); expect(queue.tracks.every(t=>t.sources[0].provider==="youtube_audio")).toBe(true);
  pass("YouTube playlist resolves to an audio song queue",{songs:queue.tracks.length,total:queue.total});
  await page.locator(".sidebar").getByRole("button",{name:"Musify links",exact:true}).click();
  await page.locator(".catalog-tabs").getByRole("button",{name:/Albums/}).click();
  await page.getByRole("textbox",{name:"Filter Musify links",exact:true}).fill("Starboy");
  await page.locator(".musify-card").getByRole("button",{name:"Play",exact:true}).click();
  await expect(page.locator(".now-playing b")).toHaveText(queue.tracks[0].title,{timeout:60000});
  await page.waitForFunction(()=>{const a=document.querySelector("audio");return a&&!a.paused&&!a.error&&a.currentTime>.4;},null,{timeout:60000});
  await page.getByRole("button",{name:"Next track",exact:true}).click();
  await expect(page.locator(".now-playing b")).toHaveText(queue.tracks[1].title,{timeout:20000});
  await page.waitForFunction(()=>{const a=document.querySelector("audio");return a&&!a.paused&&!a.error&&a.currentTime>.4;},null,{timeout:60000});
  await page.getByRole("button",{name:"Pause playback",exact:true}).click();
  pass("playlist starts in native audio mode and Next plays the following song");
  expect(embeds).toHaveLength(0);
} catch(error) {
  console.error(error); process.exitCode=1;
  if(page){console.log((await page.locator("body").innerText().catch(()=>"")).slice(-4500));await page.screenshot({path:"test-artifacts/youtube-audio-failure.png"}).catch(()=>{});}
} finally {
  fs.writeFileSync("test-artifacts/youtube-audio-verification.json",JSON.stringify({checks,videoPlayerRequests:embeds},null,2));
  await browser.close();
}

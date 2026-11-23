import { chromium, expect } from "@playwright/test";
import fs from "node:fs";
const browser = await chromium.connectOverCDP(process.env.SOUNDSPHERE_CDP_URL ?? "http://127.0.0.1:9223");
let page; const checks = [], embeds = [], exceptions = [];
try {
  page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes("localhost:5173"));
  if (!page) throw Error("Start an isolated development app.");
  await page.bringToFront();
  await page.reload();
  await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);
  const invoke = (command, args = {}) => page.evaluate(({command,args}) => window.__TAURI_INTERNALS__.invoke(command,args), {command,args});
  if (!(await invoke("runtime_info")).testMode) throw Error("Refusing to write fixtures into the normal library.");
  page.on("request", request => { if (/youtube\.com\/(embed|iframe_api)|doubleclick\.net|googlesyndication\.com/.test(request.url())) embeds.push(request.url().split("?")[0]); });
  page.on("pageerror", error => exceptions.push(String(error)));
  const pass = (name, details = {}) => { checks.push({name,...details}); console.log("PASS",name,JSON.stringify(details)); };
  await page.locator(".sidebar").getByRole("button",{name:"Musify links",exact:true}).click();
  const volume = page.getByRole("slider",{name:"Volume",exact:true}); await volume.focus(); await volume.press("Home");
  await page.getByRole("textbox",{name:"YouTube song or playlist link",exact:true}).fill("https://music.youtube.com/watch?v=a18py61_F_w");
  await page.getByRole("button",{name:"Add & play",exact:true}).click();
  const videoSource = page.locator(".source-card").filter({hasText:"YouTube video"});
  await videoSource.click({timeout:20000});
  const video = page.locator(".youtube-frame video");
  await page.waitForFunction(() => {
    const a=document.querySelector("audio"),v=document.querySelector("video");
    return a && v && !a.paused && !v.paused && !a.error && !v.error && v.videoWidth>0 && v.currentTime>.7 && Math.abs(a.currentTime-v.currentTime)<.5;
  },null,{timeout:65000});
  const info=await video.evaluate(v=>({width:v.videoWidth,height:v.videoHeight,muted:v.muted,decodedFrames:v.getVideoPlaybackQuality().totalVideoFrames,host:new URL(v.src).hostname}));
  expect(info.width).toBeGreaterThan(0); expect(info.decodedFrames).toBeGreaterThan(0); expect(info.muted).toBe(true); expect(info.host.endsWith(".googlevideo.com")).toBe(true);
  await expect(page.locator("iframe")).toHaveCount(0); expect(embeds).toHaveLength(0);
  pass("YouTube Music link plays native decoded video and audio without embedded/ad player",info);

  await page.getByRole("button",{name:"Pause playback",exact:true}).click();
  await expect.poll(()=>video.evaluate(v=>v.paused)).toBe(true);
  expect(await page.locator("audio").evaluate(a=>a.paused)).toBe(true);
  const seek=page.getByRole("slider",{name:"Seek playback",exact:true}); await seek.focus(); await seek.press("PageUp");
  await expect.poll(()=>page.evaluate(()=>Math.abs(document.querySelector("video").currentTime-document.querySelector("audio").currentTime))).toBeLessThan(.5);
  expect(await video.evaluate(v=>v.currentTime)).toBeGreaterThan(30);
  await page.getByRole("button",{name:"Start playback",exact:true}).click();
  await expect.poll(()=>video.evaluate(v=>!v.paused&&v.currentTime>30)).toBe(true);
  await page.getByRole("button",{name:"Pause video",exact:true}).click();
  await expect.poll(()=>page.locator("audio").evaluate(a=>a.paused)).toBe(true);
  pass("shared pause, seek, resume and video transport remain synchronized");

  await volume.focus(); await volume.press("ArrowRight");
  expect(await page.locator("audio").evaluate(a=>a.volume)).toBeCloseTo(.01);
  expect(await video.evaluate(v=>v.muted)).toBe(true);
  await volume.press("Home");
  await page.getByRole("button",{name:"Toggle video fullscreen",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(true);
  await page.getByRole("button",{name:"Toggle video fullscreen",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
  pass("volume has one audio output and video fullscreen works");
  await page.screenshot({path:"test-artifacts/youtube-native-video.png"});

  const before=await page.locator("audio").evaluate(a=>a.currentTime);
  await page.locator(".source-card").filter({hasText:"YouTube audio"}).click();
  await page.waitForFunction(()=>{const a=document.querySelector("audio");return a&&!a.paused&&!a.error&&a.currentTime>30;},null,{timeout:60000});
  await expect(page.locator("video")).toHaveCount(0);
  expect(await page.locator("audio").evaluate(a=>a.currentTime)).toBeGreaterThanOrEqual(before-.5);
  await page.getByRole("button",{name:"Pause playback",exact:true}).click();
  pass("switching to music mode retains playback position without a video player");

  await videoSource.click();
  await page.locator(".sidebar").getByRole("button",{name:"Musify links",exact:true}).click();
  await page.locator(".catalog-tabs").getByRole("button",{name:/Albums/}).click();
  await page.getByRole("textbox",{name:"Filter Musify links",exact:true}).fill("Starboy");
  await page.locator(".musify-card").getByRole("button",{name:"Play",exact:true}).click();
  const decoded = () => page.evaluate(()=>{const a=document.querySelector("audio"),v=document.querySelector("video");return !!(a&&v&&!a.paused&&!v.paused&&!a.error&&!v.error&&v.videoWidth>0&&v.currentTime>.5&&Math.abs(a.currentTime-v.currentTime)<.5);});
  await expect.poll(decoded,{timeout:65000}).toBe(true);
  const firstTitle=await page.locator(".now-playing b").innerText();
  await page.getByRole("button",{name:"Next track",exact:true}).click();
  await expect(page.locator(".now-playing b")).not.toHaveText(firstTitle);
  await expect(page.locator(".source-card.selected")).toContainText("YouTube video");
  await expect.poll(decoded,{timeout:65000}).toBe(true);
  await page.getByRole("button",{name:"Pause playback",exact:true}).click();
  await expect.poll(()=>page.locator("video").evaluate(v=>v.paused)).toBe(true);
  pass("playlist and Next retain video mode with synchronized native audio");
  expect(embeds).toHaveLength(0); expect(exceptions).toHaveLength(0);
} catch(error) {
  console.error(error); process.exitCode=1;
  if(page){console.log((await page.locator("body").innerText().catch(()=>"")).slice(-4000));await page.screenshot({path:"test-artifacts/youtube-video-failure.png"}).catch(()=>{});}
} finally {
  fs.writeFileSync("test-artifacts/youtube-video-verification.json",JSON.stringify({checks,videoPlayerRequests:embeds,exceptions},null,2));
  await browser.close();
}

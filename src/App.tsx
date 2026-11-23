import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { AudioLines, Search, Play, Pause, SkipBack, SkipForward, Music2, Library, Heart, ListMusic, Download, Headphones, RefreshCw, AlertCircle, Upload, FolderOpen, Settings, BookOpen, Radio, X, Plus, Trash2, Shuffle, Repeat, Repeat1, Volume2, Check, CheckCircle2 } from "lucide-react";
import { call, changeLibrary, desktop, emptyLibrary, sourceUrl } from "./api";
import type { DownloadJob, LibraryState, ProviderResult, QuranCatalog, StreamSource, Track } from "./types";
import type { MusifyCatalog } from "./types";
import { MusifyPanel } from "./MusifyPanel";
import { YouTubePlayer } from "./YouTubePlayer";

type Section = "Discover" | "Your Library" | "Favourites" | "Playlists" | "Downloads" | "Musify links" | "Quran / Tilawat" | "Naat" | "Nasheed" | "Azan" | "Settings";
const navigation: { title: string; icon: typeof Music2; group: string }[] = [
  { title: "Discover", icon: Music2, group: "LISTEN" }, { title: "Your Library", icon: Library, group: "LISTEN" },
  { title: "Favourites", icon: Heart, group: "LISTEN" }, { title: "Playlists", icon: ListMusic, group: "LISTEN" }, { title: "Downloads", icon: Download, group: "LISTEN" },
  { title: "Musify links", icon: Radio, group: "LISTEN" },
  { title: "Quran / Tilawat", icon: BookOpen, group: "ISLAMIC AUDIO" }, { title: "Naat", icon: Headphones, group: "ISLAMIC AUDIO" },
  { title: "Nasheed", icon: AudioLines, group: "ISLAMIC AUDIO" }, { title: "Azan", icon: Radio, group: "ISLAMIC AUDIO" }, { title: "Settings", icon: Settings, group: "APP" },
];
const providerNames: Record<string, string> = { audius: "Audius", jamendo: "Jamendo", archive: "Internet Archive", local: "Your library", youtube: "YouTube" };
const fmt = (n = 0) => Number.isFinite(n) ? `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}` : "0:00";
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;
const androidApp = desktop && /android/i.test(navigator.userAgent);
function savedVolume() {
  try {
    const value = Number(localStorage.getItem("soundsphere-volume") ?? ".7");
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : .7;
  } catch {
    return .7;
  }
}
function isStreamSource(value: unknown): value is StreamSource {
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  return typeof source.id === "string" && typeof source.provider === "string" && typeof source.url === "string";
}
function validTracks(value: unknown): Track[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Track[] => {
    if (!entry || typeof entry !== "object") return [];
    const track = entry as Record<string, unknown>;
    if (typeof track.id !== "string" || !track.id) return [];
    return [{
      ...(track as unknown as Track),
      title: typeof track.title === "string" && track.title ? track.title : "Unknown title",
      artist: typeof track.artist === "string" && track.artist ? track.artist : "Unknown artist",
      sources: Array.isArray(track.sources) ? track.sources.filter(isStreamSource).map(source => ({
        ...source,
        label: typeof source.label === "string" && source.label ? source.label : source.provider,
        downloadable: source.downloadable === true,
      })) : [],
      providerTrackIds: Array.isArray(track.providerTrackIds) ? track.providerTrackIds.filter((id): id is string => typeof id === "string") : [],
    }];
  });
}

export default function App() {
  const [section, setSection] = useState<Section>("Discover");
  const [library, setLibrary] = useState<LibraryState>(emptyLibrary);
  const [query, setQuery] = useState(""); const [searched, setSearched] = useState("");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [providers, setProviders] = useState<Record<string, { status: string; error?: string; count?: number }>>({});
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [startupError, setStartupError] = useState("");
  const [importing, setImporting] = useState(false);
  const [playlistId, setPlaylistId] = useState(""); const [playlistModal, setPlaylistModal] = useState(false); const [playlistName, setPlaylistName] = useState("");
  const [filter, setFilter] = useState(""); const [clientId, setClientId] = useState("");
  const [catalog, setCatalog] = useState<QuranCatalog | null>(null); const [catalogBusy, setCatalogBusy] = useState(false);
  const [musify, setMusify] = useState<MusifyCatalog | null>(null); const [musifyBusy, setMusifyBusy] = useState(false);
  const [chapter, setChapter] = useState(1); const [reciter, setReciter] = useState(7); const [mode, setMode] = useState("surah"); const [ayah, setAyah] = useState(0); const [juz, setJuz] = useState(1); const [quranBusy, setQuranBusy] = useState(false);
  const [current, setCurrent] = useState<Track | null>(null); const [sourceIndex, setSourceIndex] = useState(0); const [revision, setRevision] = useState(0);
  const [playing, setPlaying] = useState(false); const [buffering, setBuffering] = useState(false);
  const [elapsed, setElapsed] = useState(0); const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(savedVolume);
  const [shuffle, setShuffle] = useState(false); const [repeat, setRepeat] = useState<"off" | "all" | "one">("off");
  const [health, setHealth] = useState<Record<string, string>>({});
  const [playlistLoading, setPlaylistLoading] = useState(false); const playlistSequence = useRef(0);
  const audio = useRef<HTMLAudioElement>(null); const queue = useRef<Track[]>([]); const libraryRef = useRef(library);
  const [videoUrl, setVideoUrl] = useState("");
  const youtubeMode = useRef<"audio" | "video">("audio");
  const failPlayback = useRef<(reason: string) => void>(() => {});
  const searchSequence = useRef(0); const mergeSequence = useRef(0); const playbackSequence = useRef(0);
  const failedSources = useRef(new Set<string>()); const playIntent = useRef(false); const seekAfterSwitch = useRef(0);
  const nextRef = useRef<() => void>(() => {}); const toggleRef = useRef<() => void>(() => {});
  const source = current?.sources[sourceIndex];
  const searchSection = ["Discover", "Naat", "Nasheed", "Azan"].includes(section);
  const busy = Object.values(providers).some(p => p.status === "searching");
  const activePlaylist = library.playlists.find(p => p.id === playlistId);
  let visible = searchSection || section === "Quran / Tilawat" ? tracks : section === "Favourites" ? library.tracks.filter(t => library.favorites.includes(t.id)) : section === "Playlists" ? (activePlaylist?.trackIds.map(id => library.tracks.find(t => t.id === id)).filter((t): t is Track => !!t) ?? []) : library.tracks;
  if (!searchSection && section !== "Quran / Tilawat" && filter.trim()) visible = visible.filter(t => `${t.title} ${t.artist} ${t.album ?? ""}`.toLowerCase().includes(filter.toLowerCase()));
  libraryRef.current = library;

  async function reloadLibrary() { const l = await call<LibraryState>("get_library"); setLibrary(l); return l; }
  async function mutate(action: string, options: { track?: Track; id?: string; name?: string } = {}) {
    try { const l = await changeLibrary(action, options); setLibrary(l); return l; } catch (e) { setError(message(e)); return null; }
  }
  useEffect(() => {
    let alive = true;
    call<LibraryState>("get_library").then(l => { if (alive) { setLibrary(l); setClientId(l.jamendoClientId); } }).catch(e => { if (alive) setStartupError(message(e)); });
    let unlisten: (() => void) | undefined;
    if (desktop) listen<DownloadJob>("download-progress", event => {
      const d = event.payload;
      setLibrary(l => ({ ...l, downloads: [...l.downloads.filter(x => x.id !== d.id), d] }));
      if (["completed", "failed", "cancelled"].includes(d.status)) reloadLibrary().catch(e => setError(message(e)));
    }).then(fn => { if (!alive) fn(); else unlisten = fn; }).catch(e => setError(message(e)));
    return () => { alive = false; unlisten?.(); };
  }, []);
  useEffect(() => {
    if (audio.current) audio.current.volume = volume;
    try { localStorage.setItem("soundsphere-volume", String(volume)); } catch { /* Playback still works when storage is unavailable. */ }
  }, [volume]);
  useEffect(() => { setFilter(""); }, [section]);

  async function runSearch(value = query, category = section) {
    const input = value.trim(); if (!input) return;
    const term = ["Naat", "Nasheed", "Azan"].includes(category) && !input.toLowerCase().includes(category.toLowerCase()) ? `${category} ${input}` : input;
    const request = ++searchSequence.current; setSearched(term); setError(""); setTracks([]);
    const buckets: Record<string, Track[]> = {};
    const names = ["local", "audius", "archive", "jamendo", "youtube"];
    setProviders(Object.fromEntries(names.map(p => [p, { status: "searching" }])));
    await Promise.all(names.map(async provider => {
      try {
        const response = await call<ProviderResult>("search_provider", { provider, query: term });
        if (request !== searchSequence.current) return;
        const result = response && typeof response === "object" ? response : {} as ProviderResult;
        const tracks = validTracks(result.tracks);
        buckets[provider] = tracks;
        const error = typeof result.error === "string" ? result.error : !Array.isArray(result.tracks) || result.error != null ? "Provider returned incomplete search data. Please retry." : undefined;
        setProviders(p => ({ ...p, [provider]: { status: result.needsConfiguration === true ? "not-configured" : error ? "unavailable" : result.cached === true ? "cached" : "ready", error, count: tracks.length } }));
        const generation = ++mergeSequence.current;
        const merged = validTracks(await call<Track[]>("merge_tracks", { tracks: Object.values(buckets).flat() }));
        if (request === searchSequence.current && generation === mergeSequence.current) setTracks(merged);
      } catch (e) { if (request === searchSequence.current) setProviders(p => ({ ...p, [provider]: { status: "unavailable", error: message(e) } })); }
    }));
  }
  async function retryProvider(provider: string) {
    const request = searchSequence.current;
    setProviders(p => ({ ...p, [provider]: { status: "searching" } }));
    try {
      const response = await call<ProviderResult>("search_provider", { provider, query: searched });
      if (request !== searchSequence.current) return;
      const result = response && typeof response === "object" ? response : {} as ProviderResult;
      const providerTracks = validTracks(result.tracks);
      const error = typeof result.error === "string" ? result.error : !Array.isArray(result.tracks) || result.error != null ? "Provider returned incomplete search data. Please retry." : undefined;
      setProviders(p => ({ ...p, [provider]: { status: result.needsConfiguration === true ? "not-configured" : error ? "unavailable" : result.cached === true ? "cached" : "ready", error, count: providerTracks.length } }));
      const generation = ++mergeSequence.current;
      const merged = validTracks(await call<Track[]>("merge_tracks", { tracks: [...tracks, ...providerTracks] }));
      if (request === searchSequence.current && generation === mergeSequence.current) setTracks(merged);
    } catch (e) { if (request === searchSequence.current) setProviders(p => ({ ...p, [provider]: { status: "unavailable", error: message(e) } })); }
  }
  function navigate(title: Section) {
    ++searchSequence.current; ++mergeSequence.current;
    setSection(title); setTracks([]); setProviders({}); setSearched(""); setQuery("");
    if (["Naat", "Nasheed", "Azan"].includes(title)) { setQuery(title); void runSearch(title, title); }
  }
  async function loadCatalog() {
    setCatalogBusy(true);
    try {
      const result = await call<QuranCatalog>("quran_catalog");
      if (!result || !Array.isArray(result.chapters) || !Array.isArray(result.chapterReciters) || !Array.isArray(result.verseReciters)) {
        throw new Error("The catalog response is incomplete. Please retry.");
      }
      setCatalog({
        chapters: result.chapters.filter(chapter => !!chapter && typeof chapter.id === "number" && typeof chapter.name_simple === "string"),
        chapterReciters: result.chapterReciters.filter(reciter => !!reciter && typeof reciter.id === "number"),
        verseReciters: result.verseReciters.filter(reciter => !!reciter && typeof reciter.id === "number"),
      });
    } catch (e) { setError(`Quran catalog: ${message(e)}`); } finally { setCatalogBusy(false); }
  }
  async function loadMusify() {
    setMusifyBusy(true); setError("");
    try {
      const result = await call<MusifyCatalog>("musify_catalog");
      setMusify({
        ...result,
        collections: Array.isArray(result?.collections) ? result.collections.filter(item => item && typeof item.id === "string" && typeof item.title === "string" && (item.kind === "album" || item.kind === "playlist") && typeof item.url === "string") : [],
        radio: validTracks(result?.radio),
        source: typeof result?.source === "string" ? result.source : "",
        license: typeof result?.license === "string" ? result.license : "",
      });
    } catch (e) { setError(message(e)); } finally { setMusifyBusy(false); }
  }
  useEffect(() => { if (section === "Musify links" && !musify) void loadMusify(); }, [section]);
  async function openLink(url: string) { try { await call("open_link", { url }); } catch (e) { setError(message(e)); } }
  async function collectionLink(id: string, save = false) {
    try { const track = await call<Track>("musify_collection", { collectionId: id }); if (save) { if (await mutate("save", { track })) setNotice(`Saved “${track.title}” to your library.`); } else startTrack(track, [track]); }
    catch (e) { setError(message(e)); }
  }
  async function addYouTubeLink(url: string) {
    setError("");
    if (androidApp) { setError("YouTube link playback is currently available in the Windows build. On Android, use another provider or import audio files."); return; }
    try { const track = await call<Track>("resolve_youtube_link", { url }); if (await mutate("save", { track })) { setSection("Your Library"); startTrack(track, [track]); setNotice(`Added “${track.title}” to your library.`); } }
    catch (e) { setError(message(e)); }
  }
  useEffect(() => { if (section === "Quran / Tilawat" && !catalog) void loadCatalog(); }, [section]);
  async function loadQuran() {
    setQuranBusy(true); setError(""); setTracks([]);
    const request = ++searchSequence.current;
    try { const found = validTracks(await call<Track[]>("quran_tracks", { chapter, reciter, mode, ayah, juz })); if (request === searchSequence.current) { setTracks(found); setSearched(mode === "juz" ? `Juz ${juz}` : `Surah ${catalog?.chapters.find(c => c.id === chapter)?.name_simple ?? chapter}`); } }
    catch (e) { setError(message(e)); } finally { setQuranBusy(false); }
  }
  async function importAudio(folder: boolean) {
    if (androidApp && folder) return;
    setError(""); setImporting(true);
    try {
      const selected = await open({ title: folder ? "Choose your music folder" : "Import audio files", directory: folder, multiple: !folder, filters: folder ? undefined : [{ name: "Audio", extensions: ["mp3", "flac", "wav", "ogg", "m4a", "aac", "opus", "aiff"] }] });
      if (!selected) return;
      const selectedPaths = Array.isArray(selected) ? selected : [selected];
      const copyResults = androidApp
        ? await Promise.all(selectedPaths.map(uri => call<string>("copy_android_audio", { uri }).then(path => ({ path }), e => ({ error: message(e) }))))
        : selectedPaths.map(path => ({ path }));
      const paths = copyResults.flatMap(result => "path" in result ? [result.path] : []);
      const copyErrors = copyResults.flatMap(result => "error" in result ? [result.error] : []);
      if (!paths.length) throw new Error(copyErrors[0] ?? "No audio files were selected.");
      const report = await call<{ library: LibraryState; imported: number; errors: string[] }>("import_audio", { paths });
      setLibrary(report.library); setSection("Your Library");
      const errors = [...copyErrors, ...report.errors];
      setNotice(`Imported ${report.imported} audio file${report.imported === 1 ? "" : "s"}.${errors.length ? `${errors.length} skipped: ${errors.slice(0, 3).join("; ")}` : ""}`);
    } catch (e) {
      if (!message(e).toLowerCase().includes("cancel")) setError(message(e));
    } finally { setImporting(false); }
  }
  function startTrack(track: Track, items = visible) {
    if (!track.sources.length) { setError("This recording has no playable sources."); return; }
    if (androidApp && track.sources.every(s => s.provider === "youtube" || s.provider === "youtube_audio")) {
      setError("YouTube playback is currently available in the Windows build. On Android, choose another provider or import audio files.");
      return;
    }
    const request = ++playlistSequence.current;
    if (track.sources.some(s => s.provider === "youtube_audio" && s.youtubeKind === "playlist")) {
      audio.current?.pause(); playIntent.current = false;
      setPlaying(false); setBuffering(true); setPlaylistLoading(true); setError("");
      call<{ tracks: Track[]; total: number; limit: number }>("youtube_playlist", { trackId: track.id }).then(result => {
        if (request !== playlistSequence.current) return;
        setPlaylistLoading(false);
        setNotice(`Loaded ${result.tracks.length} songs from “${track.title}”.${result.total > result.limit ? ` Showing the first ${result.limit} of ${result.total} songs.` : ""}`);
        startTrack(result.tracks[0], result.tracks);
      }).catch(e => { if (request === playlistSequence.current) { setPlaylistLoading(false); setBuffering(false); setError(message(e)); } });
      return;
    }
    setPlaylistLoading(false);
    queue.current = items.length ? items.slice() : [track];
    failedSources.current.clear(); seekAfterSwitch.current = 0; playIntent.current = true;
    const preferred = libraryRef.current.preferences[track.id];
    let index = track.sources.findIndex(s => s.id === preferred);
    if (index < 0) index = track.sources.findIndex(s => Object.values(libraryRef.current.preferences).includes(s.id));
    const local = track.sources.findIndex(s => !!s.localPath);
    const mobileSource = track.sources.findIndex(s => s.provider !== "youtube" && s.provider !== "youtube_audio");
    const youtubeAudio = track.sources.findIndex(s => s.provider === (youtubeMode.current === "video" ? "youtube" : "youtube_audio"));
    if (androidApp && (index < 0 || track.sources[index].provider === "youtube" || track.sources[index].provider === "youtube_audio")) index = mobileSource;
    setCurrent(track); setSourceIndex(index >= 0 ? index : local >= 0 ? local : youtubeAudio >= 0 ? youtubeAudio : 0);
    setRevision(n => n + 1); setElapsed(0); setError("");
  }
  function next(direction = 1, ended = false) {
    if (!current || !queue.current.length) return;
    const list = queue.current;
    let i = list.findIndex(t => t.id === current.id);
    if (ended && repeat === "one") { startTrack(current, list); return; }
    if (direction < 0 && position() > 3) { seek(0); return; }
    if (shuffle && list.length > 1) { const choices = list.filter(t => t.id !== current.id); startTrack(choices[Math.floor(Math.random() * choices.length)], list); return; }
    i += direction;
    if (i < 0 || i >= list.length) { if (repeat !== "all") { if (ended) { playIntent.current = false; setPlaying(false); } return; } i = (i + list.length) % list.length; }
    startTrack(list[i], list);
  }
  nextRef.current = () => next(1, true);
  function position() { return audio.current?.currentTime ?? 0; }
  function seek(seconds: number) { if (audio.current) audio.current.currentTime = seconds; setElapsed(seconds); }
  function toggle() {
    if (playlistLoading) { ++playlistSequence.current; setPlaylistLoading(false); setBuffering(false); playIntent.current = false; return; }
    const el = audio.current; if (!el || !current) return;
    if (playing || buffering) { playIntent.current = false; el.pause(); setPlaying(false); setBuffering(false); }
    else {
      playIntent.current = true;
      if (!el.src || el.error || el.ended || el.readyState === 0) { failedSources.current.clear(); seekAfterSwitch.current = el.ended ? 0 : el.currentTime; setRevision(n => n + 1); }
      else el.play().catch(e => setError(message(e)));
    }
  }
  toggleRef.current = toggle;
  function chooseSource(index: number) {
    if (!current) return;
    if (androidApp && (current.sources[index].provider === "youtube" || current.sources[index].provider === "youtube_audio")) {
      setError("YouTube playback is currently available in the Windows build.");
      return;
    }
    if (current.sources[index].provider === "youtube") youtubeMode.current = "video";
    else if (current.sources[index].provider === "youtube_audio") youtubeMode.current = "audio";
    seekAfterSwitch.current = position(); failedSources.current.clear(); playIntent.current = true;
    setSourceIndex(index); setRevision(n => n + 1); setError("");
    void mutate("preference", { id: current.id, name: current.sources[index].id });
  }
  useEffect(() => {
    const el = audio.current;
    if (!el || !current || !source) return;
    const token = ++playbackSequence.current;
    let disposed = false; let failed = false; let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const active = () => !disposed && token === playbackSequence.current;
    const clearStall = () => { if (stallTimer) clearTimeout(stallTimer); };
    function fail(reason: string) {
      if (!active() || failed) return; failed = true; clearStall();
      failedSources.current.add(source!.id); setHealth(h => ({ ...h, [source!.id]: "failed" }));
      const ordered = current!.sources.map((_, offset) => (sourceIndex + offset + 1) % current!.sources.length);
      const alternative = ordered.find(i => !failedSources.current.has(current!.sources[i].id) && !(source!.provider === "youtube_audio" && current!.sources[i].provider === "youtube"));
      if (alternative !== undefined) {
        seekAfterSwitch.current = position() || seekAfterSwitch.current;
        setNotice(`${source!.label} failed. Trying ${current!.sources[alternative].label}.`); setSourceIndex(alternative);
      } else { playIntent.current = false; el!.pause(); setPlaying(false); setBuffering(false); setError(`All sources failed for “${current!.title}”. ${reason} You can choose a source to retry.`); }
    }
    el.pause(); el.removeAttribute("src"); el.load(); setVideoUrl(""); setPlaying(false); setBuffering(true); setDuration(current.duration ?? 0);
    setHealth(h => ({ ...h, [source.id]: "checking" }));
    failPlayback.current = fail;
    if (source.provider === "youtube") {
      document.querySelector(".youtube-panel")?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    el.onloadedmetadata = () => { if (active()) { setDuration(Number.isFinite(el.duration) ? el.duration : current.duration ?? 0); if (seekAfterSwitch.current > 0 && Number.isFinite(el.duration)) el.currentTime = Math.min(seekAfterSwitch.current, Math.max(0, el.duration - .2)); seekAfterSwitch.current = 0; } };
    let lastProgress = 0;
    el.ontimeupdate = () => { if (active()) { setElapsed(el.currentTime); if (Math.abs(el.currentTime - lastProgress) > .05) { clearStall(); lastProgress = el.currentTime; } } };
    el.onplaying = () => { if (active()) { clearStall(); setPlaying(true); setBuffering(false); setHealth(h => ({ ...h, [source.id]: "playing" })); } };
    el.onpause = () => { if (active()) { setPlaying(false); setHealth(h => h[source.id] === "playing" ? { ...h, [source.id]: "ready" } : h); } };
    el.onwaiting = () => { if (active() && playIntent.current) { setBuffering(true); clearStall(); stallTimer = setTimeout(() => { if (playIntent.current) fail("Stream stopped responding."); }, 15000); } };
    el.onstalled = el.onwaiting;
    el.onerror = () => fail(el.error?.message || "Audio could not be decoded or loaded.");
    el.onended = () => { clearStall(); setPlaying(false); setBuffering(false); nextRef.current(); };
    (async () => {
      try {
        const resolved = await call<{ url?: string; videoUrl?: string }>("check_source", { trackId: current.id, sourceId: source.id, refresh: health[source.id] === "failed" });
        if (!active()) return;
        setVideoUrl(source.provider === "youtube" ? resolved.videoUrl ?? "" : "");
        setHealth(h => ({ ...h, [source.id]: "ready" })); el.src = resolved.url ?? sourceUrl(source); el.load();
        if (playIntent.current) { clearStall(); stallTimer = setTimeout(() => fail("Audio loading timed out."), 15000); }
        if (playIntent.current) await el.play(); else setBuffering(false);
      } catch (e) {
        if (e instanceof DOMException && e.name === "NotAllowedError") { setError("Press Play to allow audio playback."); setBuffering(false); playIntent.current = false; }
        else fail(message(e));
      }
    })();
    return () => { disposed = true; clearStall(); el.onloadedmetadata = el.ontimeupdate = el.onplaying = el.onpause = el.onwaiting = el.onstalled = el.onerror = el.onended = null; el.pause(); };
  }, [current?.id, sourceIndex, revision]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.code === "Space" && !(event.target instanceof HTMLElement && (event.target.matches("input,select,textarea,button") || event.target.isContentEditable))) { event.preventDefault(); toggleRef.current(); } };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    if (!("mediaSession" in navigator) || !current) return;
    try {
      if (typeof MediaMetadata !== "undefined") navigator.mediaSession.metadata = new MediaMetadata({ title: current.title, artist: current.artist, album: current.album ?? "SoundSphere", artwork: current.artwork ? [{ src: current.artwork }] : [] });
    } catch { /* WebViews can expose mediaSession without supporting artwork metadata. */ }
    const actions: [MediaSessionAction, MediaSessionActionHandler][] = [["play", () => { if (!playing) toggleRef.current(); }], ["pause", () => { if (playing) toggleRef.current(); }], ["previoustrack", () => next(-1)], ["nexttrack", () => next()], ["seekto", event => { if (event.seekTime !== undefined) seek(event.seekTime); }]];
    for (const [action, handler] of actions) { try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* WebView may not implement every transport action. */ } }
    try { navigator.mediaSession.playbackState = playing ? "playing" : "paused"; } catch { /* Ignore incomplete WebView media-session implementations. */ }
    return () => { for (const [action] of actions) { try { navigator.mediaSession.setActionHandler(action, null); } catch {} } };
  }, [current, sourceIndex, playing, shuffle, repeat]);
  async function enqueue(track: Track, sourceId?: string) {
    const selected = track.sources.find(s => s.id === sourceId && s.downloadable) ?? track.sources.find(s => s.downloadable);
    if (!selected) { setError("No source for this recording permits offline downloads."); return; }
    setNotice(`Added “${track.title}” to the download queue.`);
    try { const job = await call<DownloadJob>("download_track", { trackId: track.id, sourceId: selected.id }); if (job.status === "failed") setError(job.error ?? "Download failed"); }
    catch (e) { setError(message(e)); }
  }
  const qaris = mode === "surah" ? catalog?.chapterReciters ?? [] : catalog?.verseReciters ?? [];
  const headerSubtitle = section === "Quran / Tilawat" ? "Surahs, ayahs and Juz. Choose your Qari." : section === "Your Library" ? "Your saved recordings and imported audio." : section === "Downloads" ? "Permitted audio, available offline." : "One recording. All its sources.";

  return <div className={`app ${source?.provider === "youtube" ? "youtube-active" : ""}`}>
    <aside className="sidebar">
      <div className="brand"><div className="brand-icon"><AudioLines size={23} /></div><span>Sound<span className="accent">Sphere</span></span></div>
      <div className="navigation">{navigation.map(({ title, icon: Icon, group }, i) => <div key={title}>{navigation[i - 1]?.group !== group && <div className="nav-label">{group}</div>}<button className={`nav-item ${section === title ? "active" : ""}`} onClick={() => navigate(title as Section)}><Icon size={18} /><span>{title}</span>{title === "Downloads" && library.downloads.some(d => ["queued", "downloading"].includes(d.status)) && <span className="activity-dot" />}</button></div>)}</div>
      <div className="sidebar-bottom"><span className={`status-dot ${startupError ? "offline" : ""}`} />{startupError ? "Engine unavailable" : "Local music engine"}<small>No app ads · Your library stays on this device</small></div>
    </aside>
    <main className="main">
      <header><div><div className="eyebrow">YOUR AUDIO, ONE PLACE</div><h1>{section}</h1><p>{headerSubtitle}</p></div><div className="header-actions"><button className="button subtle" onClick={() => importAudio(false)} disabled={importing || !!startupError} title="Import audio files" aria-label="Import audio files">{importing ? <RefreshCw className="spin" size={16} /> : <Upload size={16} />} Import audio</button>{!androidApp && <button className="icon-button" onClick={() => importAudio(true)} title="Index a music folder" aria-label="Index a music folder" disabled={importing || !!startupError}><FolderOpen size={19} /></button>}</div></header>
      <label className="mobile-nav">Go to<select value={section} onChange={e => navigate(e.target.value as Section)}>{navigation.map(n => <option key={n.title}>{n.title}</option>)}</select></label>
      {startupError && <div className="notice error" role="alert"><AlertCircle size={19} /><div><b>{androidApp ? "Audio engine unavailable" : "Desktop engine unavailable"}</b><p>{startupError}</p>{!androidApp && <p>Use the standalone SoundSphere.exe in C:\dev\SoundSphere, or run npm run tauri dev from that folder.</p>}</div></div>}
      {error && <div className="notice error" role="alert"><AlertCircle size={18} /><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error"><X size={16} /></button></div>}
      {notice && <div className="notice info" role="status"><CheckCircle2 size={17} /><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss notice"><X size={16} /></button></div>}

      {current && source?.provider === "youtube" && source.youtubeId && <section className="panel youtube-panel"><div className="section-head"><div><div className="eyebrow">YOUTUBE VIDEO</div><h2>{current.title}</h2><p>{current.artist}</p></div><span className="badge">Ad-free playback</span></div><YouTubePlayer key={`${source.id}:${revision}`} url={videoUrl} audio={audio} playing={playing} toggle={toggle} onError={reason => failPlayback.current(reason)} /><p className="attribution">Audio and video play directly in SoundSphere. Use the playback bar to seek, adjust volume or move to the next song.</p></section>}

      {searchSection && <>
        <section className="hero"><div className="hero-copy"><div className="eyebrow">{section === "Discover" ? "A WORLD OF INDEPENDENT AUDIO" : `${section.toUpperCase()} COLLECTIONS`}</div><h2>Find your next<br /><span className="gradient">favourite sound.</span></h2><p>Search connected catalogs and your library. Matching recordings stay together, with a choice of streaming sources.</p><form className="search" onSubmit={e => { e.preventDefault(); void runSearch(); }}><Search size={19} /><input aria-label="Search audio" value={query} onChange={e => setQuery(e.target.value)} placeholder={section === "Discover" ? "Search a song, artist or recording…" : `Search ${section.toLowerCase()} or a reciter…`} /><button disabled={!query.trim() || !!startupError}>{busy ? <RefreshCw className="spin" size={17} /> : "Search"}</button></form><div className="suggestions">{(section === "Discover" ? ["lofi", "piano", "ambient"] : [section, `${section} Urdu`, `${section} Arabic`]).map(t => <button key={t} onClick={() => { setQuery(t); void runSearch(t); }}>{t}</button>)}</div></div><div className="hero-art" aria-hidden="true"><div className="orbit" /><div className="orbit outer" /><div className={`disc ${playing ? "rotating" : ""}`}><div className="disc-center"><AudioLines size={40} /></div></div><span className="floating">Multiple sources.<br /><b>One listening space.</b></span></div></section>
        {Object.keys(providers).length > 0 && <div className="provider-grid">{Object.entries(providers).map(([name, p]) => <div className={`provider-status ${p.status}`} key={name}><div>{p.status === "searching" ? <RefreshCw size={13} className="spin" /> : p.status === "not-configured" ? <Settings size={13} /> : p.status === "unavailable" ? <AlertCircle size={13} /> : <Check size={13} />}<b>{providerNames[name] ?? name}</b><small>{p.status === "searching" ? "Searching…" : p.status === "not-configured" ? "Needs setup" : p.status === "unavailable" ? "Unavailable" : `${p.count ?? 0} results${p.status === "cached" ? " · cached" : ""}`}</small></div>{p.error && <p>{p.error}</p>}{androidApp && name === "youtube" && <p>Search results only; YouTube playback is unavailable on Android.</p>}{p.status === "not-configured" && <button className="provider-action" onClick={() => navigate("Settings")}><Settings size={12} /> Configure Jamendo</button>}{p.status === "unavailable" && <button className="provider-action" disabled={busy} onClick={() => retryProvider(name)}><RefreshCw size={12} /> Retry {providerNames[name] ?? name}</button>}</div>)}</div>}
      </>}

      {section === "Quran / Tilawat" && <section className="panel quran-panel"><div className="panel-heading"><BookOpen size={24} /><div><h2>A quiet space for recitation</h2><p>Quran Foundation audio · EveryAyah alternatives for supported Qaris</p></div></div>{catalogBusy ? <p className="loading"><RefreshCw className="spin" size={18} /> Loading Surahs and reciters…</p> : !catalog ? <button className="button" onClick={loadCatalog}>Retry catalog</button> : <form className="quran-form" onSubmit={e => { e.preventDefault(); void loadQuran(); }}><label>Listen by<select value={mode} onChange={e => { setMode(e.target.value); setReciter(7); }}><option value="surah">Complete Surah</option><option value="ayah">Ayah by Ayah</option><option value="juz">Juz</option></select></label>{mode !== "juz" ? <label>Surah<select value={chapter} onChange={e => { setChapter(Number(e.target.value)); setAyah(0); }}>{catalog.chapters.map(c => <option key={c.id} value={c.id}>{c.id}. {c.name_simple} — {c.name_arabic}</option>)}</select></label> : <label>Juz<select value={juz} onChange={e => setJuz(Number(e.target.value))}>{Array.from({ length: 30 }, (_, i) => <option key={i} value={i + 1}>Juz {i + 1}</option>)}</select></label>}<label>Qari<select value={reciter} onChange={e => setReciter(Number(e.target.value))}>{qaris.map(r => <option key={r.id} value={r.id}>{r.name ?? r.reciter_name}{typeof r.style === "string" && r.style ? ` · ${r.style}` : ""}</option>)}</select></label>{mode === "ayah" && <label>Ayah (0 = all)<input aria-label="Ayah number" type="number" min="0" max={catalog.chapters.find(c => c.id === chapter)?.verses_count ?? 286} value={ayah} onChange={e => setAyah(Number(e.target.value))} /></label>}<button className="button" disabled={quranBusy}>{quranBusy ? <RefreshCw className="spin" size={16} /> : <Headphones size={16} />} Load recitation</button></form>}<small className="attribution">Audio credited to Quran Foundation and the named reciter. Offline downloads are for personal listening under their Developer Terms.</small></section>}

      {section === "Playlists" && <section className="playlist-browser"><div className="section-head"><h2>Your collections</h2><button className="button subtle" onClick={() => setPlaylistModal(true)}><Plus size={16} /> New playlist</button></div><div className="playlist-tabs">{library.playlists.map(p => <button className={p.id === playlistId ? "selected" : ""} key={p.id} onClick={() => setPlaylistId(p.id)}><ListMusic size={17} /><b>{p.name}</b><small>{p.trackIds.length} tracks</small></button>)}</div>{activePlaylist && <div className="section-head"><h3>{activePlaylist.name}</h3><button className="text-button danger" onClick={async () => { await mutate("playlist_delete", { id: playlistId }); setPlaylistId(""); }}><Trash2 size={14} /> Delete playlist</button></div>}</section>}

      {section === "Musify links" ? <MusifyPanel catalog={musify} loading={musifyBusy} reload={loadMusify} playCollection={id => collectionLink(id)} saveCollection={id => collectionLink(id, true)} playRadio={(track, items) => startTrack(track, items)} addLink={addYouTubeLink} openLink={openLink} /> : section === "Settings" ? <section className="panel settings-panel"><h2>Connected providers</h2><p>Searches run in parallel. Each provider reports its own connection errors.</p><div className="setting-row"><div><b>Audius</b><small>Independent music streaming. An optional AUDIUS_API_KEY environment variable supports your own API key.</small></div><span className="badge">Enabled</span></div><div className="setting-row"><div><b>Internet Archive</b><small>Audio items with Creative Commons or public-domain license metadata. Attribution and license stay with each source.</small></div><span className="badge">Enabled</span></div><div className="setting-row"><div><b>Quran Foundation / EveryAyah</b><small>Surah and verse audio. EveryAyah alternatives are available for Alafasy, Sudais and Husary verse recitations. If public API access changes, QURAN_API_BASE_URL can point to your authenticated backend proxy.</small></div><span className="badge">Enabled</span></div><form className="setting-form" onSubmit={async e => { e.preventDefault(); if (await mutate("settings", { name: clientId })) setNotice("Jamendo settings saved. Run a new search to connect."); }}><label>Jamendo client ID<input value={clientId} onChange={e => setClientId(e.target.value)} placeholder="Your developer client ID" /></label><button className="button" type="submit">Save provider</button><small>Get your own client ID from developer.jamendo.com. No shared credentials are bundled.</small></form><div className="setting-row"><div><b>On this device</b><small>Library, favourites, playlists, source preferences, download history and metadata cache are stored in SQLite. Imported files remain in their original folders.</small></div></div><div className="setting-row"><div><b>YouTube / Musify links</b><small>YouTube songs use audio mode by default. Playlist links load a song queue. Audio and video both play directly in SoundSphere without the YouTube ad player. Choose YouTube video from the source selector to watch. Musify album, playlist and radio links are available under Musify links.</small></div></div></section> : section === "Downloads" ? <section><div className="section-head"><h2>Download queue</h2><span className="count">{library.downloads.length} files</span></div>{!library.downloads.length && <Empty icon={Download} title="Take permitted audio with you" text="Download buttons appear only when a source supplies download permission. Completed files join your library for offline playback." />}{library.downloads.slice().reverse().map(d => <div className="download-row panel" key={d.id}><Download size={22} /><div><b>{d.title}</b><small className={d.status === "failed" ? "danger" : ""}>{d.status} · {mb(d.bytes)}{d.total ? ` / ${mb(d.total)}` : ""}{d.error ? ` · ${d.error}` : ""}</small>{["queued", "downloading"].includes(d.status) && <progress max={d.total ?? 1} value={d.total ? d.bytes : 0} />}{d.path && <small className="file-path">{d.path}</small>}</div>{["queued", "downloading"].includes(d.status) ? <button className="button subtle" onClick={() => mutate("cancel_download", { id: d.id })}>Cancel</button> : ["failed", "cancelled"].includes(d.status) ? <button className="button subtle" onClick={async () => { try { const t = library.tracks.find(t => t.id === d.trackId); if (t) await enqueue(t, d.sourceId); else { const job = await call<DownloadJob>("download_track", { trackId: d.trackId, sourceId: d.sourceId }); if (job.error) setError(job.error); } } catch (e) { setError(message(e)); } }}>Retry</button> : <CheckCircle2 className="success" size={20} />}</div>)}</section> : <section className="results"><div className="section-head"><div><div className="eyebrow">{searchSection ? "SEARCH RESULTS" : "RECORDINGS"}</div><h2>{searched ? `Matches for “${searched}”` : section === "Playlists" ? "Playlist tracks" : section === "Your Library" ? "All your audio" : section === "Favourites" ? "The ones you love" : section === "Quran / Tilawat" ? "Your recitation queue" : "Start exploring"}</h2></div><div className="results-actions"><span className="count">{visible.length} recordings</span>{visible.length > 0 && <button className="button subtle" onClick={() => startTrack(visible[0])}><Play size={14} /> Play all</button>}</div></div>{["Your Library", "Favourites", "Playlists"].includes(section) && <input className="library-filter" aria-label="Filter library" placeholder="Filter by title, artist or album…" value={filter} onChange={e => setFilter(e.target.value)} />}{(busy || quranBusy) && <div className="loading"><RefreshCw className="spin" size={16} />{visible.length ? "More providers are searching…" : "Finding your audio…"}</div>}{!visible.length && !busy && !quranBusy && <Empty icon={section === "Favourites" ? Heart : section === "Playlists" ? ListMusic : Music2} title={searched ? "No matching recordings" : section === "Your Library" ? "Build your listening library" : section === "Favourites" ? "Keep your favourites close" : section === "Playlists" ? "A collection for every mood" : section === "Quran / Tilawat" ? "Choose a Surah and Qari above" : "One search. Multiple sources."} text={searched ? "Try a different title or artist. Provider connection details appear above; catalog coverage varies." : section === "Your Library" ? "Import audio files, index a folder, or save recordings from search. Your own files work without an internet connection." : section === "Favourites" ? "Tap the heart beside a recording to save it here." : section === "Playlists" ? "Create a playlist, then add recordings using the playlist menu beside each track." : "Search a catalog or import your own audio to begin."} />}
        <div className="track-list">{visible.map((t, i) => <div className={`track-row ${current?.id === t.id ? "current" : ""}`} key={t.id}><button className="track-number" aria-label={`Play ${t.title}`} onClick={() => startTrack(t)}>{current?.id === t.id && playing ? <AudioLines size={16} /> : <span>{String(i + 1).padStart(2, "0")}</span>}</button><div className="cover">{t.artwork ? <img loading="lazy" src={t.artwork} alt="" onError={e => { e.currentTarget.style.display = "none"; }} /> : <Music2 size={20} />}</div><button className="track-info" onClick={() => startTrack(t)}><strong>{t.title}</strong><span>{t.artist}{t.album ? ` · ${t.album}` : ""}</span></button><span className="source-count">{t.sources.length} source{t.sources.length === 1 ? "" : "s"}</span><span className="duration">{t.duration ? fmt(t.duration) : "—"}</span><div className="track-actions"><button aria-label={`Favourite ${t.title}`} title="Favourite" className={`icon-button ${library.favorites.includes(t.id) ? "hearted" : ""}`} onClick={() => mutate("favorite", { track: t, id: t.id })}><Heart size={16} fill={library.favorites.includes(t.id) ? "currentColor" : "none"} /></button><button className="icon-button" aria-label={`Save ${t.title}`} title="Save to library" onClick={async () => { if (await mutate("save", { track: t })) setNotice(`Saved “${t.title}” to your library.`); }}><Library size={16} /></button>{t.sources.some(s => s.downloadable) && <button className="icon-button" aria-label={`Download ${t.title}`} title="Download permitted source" onClick={() => enqueue(t)}><Download size={16} /></button>}<select className="add-playlist" aria-label={`Add ${t.title} to playlist`} value="" onChange={e => { if (e.target.value === "new") { setPlaylistModal(true); setNotice("Create a playlist, then use this menu to add the recording."); } else void mutate("playlist_add", { track: t, id: e.target.value }); }}><option value="" disabled>+ Playlist</option>{library.playlists.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}<option value="new">New playlist…</option></select>{section === "Playlists" && <button className="icon-button danger" title="Remove from playlist" aria-label={`Remove ${t.title} from playlist`} onClick={() => mutate("playlist_remove", { id: playlistId, name: t.id })}><X size={15} /></button>}{section === "Your Library" && <button className="icon-button danger" title="Remove from library (keeps audio file)" aria-label={`Remove ${t.title} from library`} onClick={() => mutate("remove", { id: t.id })}><X size={15} /></button>}<button className="play-small" aria-label={`Play ${t.title} now`} onClick={() => startTrack(t)}><Play size={14} fill="currentColor" /></button></div></div>)}</div>
      </section>}

      {current && <section className="panel sources-panel"><div className="section-head"><div><div className="eyebrow">STREAM SELECTOR</div><h2>{current.title}</h2><p>{current.artist} · Sources are checked when selected.</p></div><span className="badge">{current.sources.length} alternatives</span></div><div className="sources-grid">{current.sources.map((s, i) => <button key={s.id} className={`source-card ${i === sourceIndex ? "selected" : ""}`} onClick={() => chooseSource(i)}><div><Radio size={17} /><b>{s.label}</b>{i === sourceIndex && <Check size={16} />}</div><small>{s.quality ?? (s.localPath ? "On this device" : "Provider stream")}</small><span className={`health ${health[s.id] ?? "unchecked"}`}>{health[s.id] ?? "Not checked"}</span>{s.license && <small className="license">{s.license}</small>}</button>)}</div>{source?.attribution && <p className="source-credit">Source credit: {source.attribution}</p>}{source?.downloadable && <button className="button subtle" onClick={() => enqueue(current, source.id)}><Download size={15} /> Download selected source</button>}</section>}
      {section === "Discover" && <section className="collections"><div className="section-head"><div><div className="eyebrow">EXPLORE BY TYPE</div><h2>Made for every listening mood</h2></div></div><div className="collection-grid">{[{ name: "Quran / Tilawat", sub: "Surah · Ayah · Qari · Juz", icon: BookOpen, color: "green" }, { name: "Naat", sub: "Reciters and collections", icon: Headphones, color: "rose" }, { name: "Nasheed", sub: "Arabic · Urdu · English", icon: AudioLines, color: "purple" }, { name: "Azan", sub: "Calls to prayer", icon: Radio, color: "blue" }].map(({ name, sub, icon: Icon, color }) => <button key={name} onClick={() => navigate(name as Section)}><span className={`collection-icon ${color}`}><Icon size={22} /></span><b>{name}</b><small>{sub}</small></button>)}</div></section>}
      <div className="page-footnote">SoundSphere · Independent catalogs and your own audio. Availability depends on each provider.</div>
    </main>
    <footer className="player"><div className="now-playing"><div className="mini-cover"><Music2 size={22} /></div><div><b>{current?.title ?? "Nothing playing"}</b><small>{current?.artist ?? "Choose a recording to begin"}</small><small className="accent">{buffering ? "Connecting…" : playing ? `Playing · ${source?.label}` : current ? "Paused" : ""}</small></div></div><div className="player-controls"><div className="controls"><button className={shuffle ? "enabled" : ""} title="Shuffle" aria-label="Shuffle" aria-pressed={shuffle} onClick={() => setShuffle(!shuffle)}><Shuffle size={15} /></button><button title="Previous" aria-label="Previous track" disabled={!current} onClick={() => next(-1)}><SkipBack size={18} /></button><button className={`main-play ${playing ? "playing" : ""}`} aria-label={playing || buffering ? "Pause playback" : "Start playback"} disabled={!current && !playlistLoading} onClick={toggle}>{buffering ? <RefreshCw className="spin" size={19} /> : playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button><button title="Next" aria-label="Next track" disabled={!current} onClick={() => next()}><SkipForward size={18} /></button><button className={repeat !== "off" ? "enabled" : ""} title={`Repeat: ${repeat}`} aria-label={`Repeat: ${repeat}`} onClick={() => setRepeat(repeat === "off" ? "all" : repeat === "all" ? "one" : "off")}>{repeat === "one" ? <Repeat1 size={16} /> : <Repeat size={16} />}</button></div><div className="progress"><span data-testid="elapsed">{fmt(elapsed)}</span><input type="range" aria-label="Seek playback" min="0" max={Math.max(1, duration)} step="0.1" value={Math.min(elapsed, duration || 1)} disabled={!current || !duration} onChange={e => seek(Number(e.target.value))} /><span>{fmt(duration)}</span></div></div><div className="player-right"><Volume2 size={17} /><input aria-label="Volume" type="range" min="0" max="1" step="0.01" value={volume} onChange={e => setVolume(Number(e.target.value))} />{current && <select aria-label="Select stream source" value={sourceIndex} onChange={e => chooseSource(Number(e.target.value))}>{current.sources.map((s, i) => <option key={s.id} value={i}>{s.label}</option>)}</select>}</div><audio ref={audio} preload="metadata" /></footer>
    {playlistModal && <div className="modal-backdrop"><form className="modal" role="dialog" aria-modal="true" aria-label="Create playlist" onSubmit={async e => { e.preventDefault(); const l = await mutate("playlist_create", { name: playlistName }); if (l) { setPlaylistId(l.playlists[l.playlists.length - 1].id); setPlaylistName(""); setPlaylistModal(false); setNotice("Playlist created. Add tracks using their playlist menu."); } }}><div className="section-head"><h2>A new listening space</h2><button type="button" className="icon-button" aria-label="Close playlist dialog" onClick={() => setPlaylistModal(false)}><X size={18} /></button></div><label>Playlist name<input autoFocus required maxLength={100} value={playlistName} onChange={e => setPlaylistName(e.target.value)} placeholder="Evening favourites" /></label><button className="button" disabled={!playlistName.trim()}>Create playlist</button></form></div>}
  </div>;
}

function Empty({ icon: Icon, title, text }: { icon: typeof Music2; title: string; text: string }) {
  return <div className="empty"><div className="empty-icon"><Icon size={27} /></div><h3>{title}</h3><p>{text}</p></div>;
}

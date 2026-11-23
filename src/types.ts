export type ProviderId = "audius" | "jamendo" | "archive" | "quran" | "everyayah" | "local" | "youtube" | "youtube_audio" | "radio";
export type StreamSource = {
  id: string; provider: ProviderId; label: string; url: string; downloadable: boolean;
  downloadUrl?: string; localPath?: string; attribution?: string; license?: string; quality?: string;
  youtubeId?: string; youtubeKind?: "video" | "playlist";
};
export type Track = {
  id: string; title: string; artist: string; album?: string; artwork?: string; duration?: number;
  isrc?: string; sources: StreamSource[]; providerTrackIds: string[];
};
export type Playlist = { id: string; name: string; trackIds: string[] };
export type DownloadJob = {
  id: string; trackId: string; sourceId: string; title: string;
  status: "queued" | "downloading" | "completed" | "failed" | "cancelled";
  bytes: number; total?: number; error?: string; path?: string;
};
export type LibraryState = {
  tracks: Track[]; favorites: string[]; playlists: Playlist[]; preferences: Record<string, string>;
  downloads: DownloadJob[]; jamendoClientId: string;
};
export type ProviderResult = { provider: string; tracks: Track[]; error?: string; cached: boolean; needsConfiguration: boolean };
export type Chapter = { id: number; name_simple: string; name_arabic: string; verses_count: number };
export type Reciter = { id: number; name?: string; reciter_name?: string; style?: unknown };
export type QuranCatalog = { chapters: Chapter[]; chapterReciters: Reciter[]; verseReciters: Reciter[] };
export type MusifyCollection = { id: string; title: string; kind: "playlist" | "album"; url: string; image?: string };
export type MusifyCatalog = { collections: MusifyCollection[]; radio: Track[]; source: string; license: string };

import { invoke, isTauri, convertFileSrc } from "@tauri-apps/api/core";
import type { LibraryState, StreamSource, Track } from "./types";

export const desktop = isTauri();
export function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!desktop) return Promise.reject(new Error("Open SoundSphere.exe to use the music engine. Browser preview has no desktop backend."));
  return invoke<T>(command, args);
}
export function sourceUrl(source: StreamSource): string {
  return source.localPath ? convertFileSrc(source.localPath) : source.url;
}
export function changeLibrary(action: string, options: { track?: Track; id?: string; name?: string } = {}) {
  return call<LibraryState>("library_action", { action, track: options.track ?? null, id: options.id ?? null, name: options.name ?? null });
}
export const emptyLibrary: LibraryState = { tracks: [], favorites: [], playlists: [], preferences: {}, downloads: [], jamendoClientId: "" };

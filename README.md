# SoundSphere

**A fast, privacy-focused music player for Windows and Android.**

SoundSphere brings music discovery and playback together in one native Tauri desktop app. Search across multiple providers, organize your library, create playlists, download permitted tracks, listen to Quran recitations or Azan, and play YouTube content without an embedded player.

## Highlights

- Search YouTube, Audius, Internet Archive, optional Jamendo, and the local library
- Merge matching recordings from different sources into one result
- Check streams, switch sources, and remember preferred providers
- Play, pause, seek, shuffle, repeat, queue, and control playback with media keys
- Import and index local audio files with metadata and duration detection
- Build playlists and a saved favourites library
- Download permitted audio with a cancellable, retryable queue
- Listen to Quran chapters and individual ayahs with selectable reciters
- Browse Naat, Nasheed, Azan, and curated Musify catalogs
- Stream public YouTube videos and playlists in synchronized native audio/video mode
- Store preferences and media metadata locally in SQLite

## Supported content

### Music providers

| Provider | Status | Notes |
|---|---|---|
| YouTube | Built-in | Public metadata and native stream playback |
| Audius | Built-in | Public API; optional API key supported |
| Internet Archive | Built-in | Restricted to CC/public-domain metadata |
| Jamendo | Optional | Requires a developer client ID |
| Local library | Built-in | Recursive folders and local audio files |

YouTube playback uses a pinned, checksum-verified yt-dlp helper prepared on the user's machine. SoundSphere does not embed the YouTube player or third-party scripts. Private, removed, restricted, or unavailable videos are reported normally.

### Spoken and religious audio

- Full Quran Surah support with selectable reciters
- Individual ayah and Juz queues
- Alafasy, Sudais, and Husary source alternatives
- Naat, Nasheed, and Azan discovery
- Musify playlist, album, and radio catalogs

Provider availability and upstream catalogs can change. Quran and EveryAyah recordings remain attributed to their respective sources.

## Getting started

### Requirements

- Windows 10 or Windows 11
- Microsoft Edge WebView2 Runtime
- Node.js 20+
- Rust stable
- Visual Studio C++ Build Tools
- Windows 10/11 SDK

### Development

```powershell
git clone https://github.com/TahaAkber/SoundSphere.git
cd SoundSphere
npm install
npm run prepare:youtube
npm run tauri dev
```

Use `npm run dev` only for frontend preview. It cannot exercise Tauri native commands.

### Production build

```powershell
npm run desktop:build
```

The build script prepares the pinned YouTube runtime and creates a standalone Windows executable.

### Android build

Install Node.js 20+, Rust stable with the Android targets, a JDK supported by Android Gradle Plugin, and Android SDK Platform/Build Tools plus NDK. On Windows, enable Developer Mode (or build from an elevated terminal) so Tauri can link native Android libraries. Then initialize and run the Android target:

```powershell
npm ci
npm run tauri -- android init
npm run android:dev
```

Create release APK and AAB packages with `npm run android:build`, or a debug APK with `npm run android:debug`. Android audio imports use the system file picker and copy selected files into SoundSphere's private app storage; Android does not request broad storage access. Folder indexing and YouTube stream playback remain Windows-only; YouTube search metadata is still included on Android. Android playback supports the available HTTPS catalogs, imported audio, and local downloads.

For signed release builds, create `src-tauri/gen/android/app/key.properties` locally with `storeFile`, `storePassword`, `keyAlias`, and `keyPassword`. `storeFile` is relative to that `app` directory unless you use an absolute path. The Android project ignores this file; never commit signing keys or passwords. Without it, Gradle produces unsigned release artifacts.

## Configuration

Copy `.env.example` to `.env` and set provider values before launching:

```text
JAMENDO_CLIENT_ID=
AUDIUS_API_KEY=
QURAN_API_BASE_URL=https://api.quran.com/api/v4
```

- `AUDIUS_API_KEY` is optional.
- `JAMENDO_CLIENT_ID` can also be entered in the app's Settings screen.
- `QURAN_API_BASE_URL` must be set in the launching environment. Vite `.env` files are not read by the Rust backend.
- Provider secrets are not bundled into the frontend.

Jamendo download behavior follows artist permissions and the download URL returned by Jamendo. YouTube and EveryAyah entries do not expose downloads.

## Data and privacy

SoundSphere keeps application data in Tauri's application-data directory for `com.soundsphere.player`:

- `soundsphere.sqlite` for library, playlists, preferences, downloads, and metadata
- `downloads/` for completed offline files

Removing a recording from the library does not delete the user's original file. Unfinished downloads are marked interrupted after a restart and can be retried.

No advertising SDK, subscription paywall, or torrent dependency is included.

## Verification

The desktop test suite uses an isolated test database and generated audio fixtures.

```powershell
npm run build
cargo test --manifest-path src-tauri\Cargo.toml --lib
npm run test:desktop
npm run test:musify
npm run test:youtube-audio
npm run test:youtube-video
```

Desktop checks require a running Tauri development instance and the live public provider services.

## Platform status

- **Windows:** primary and maintained target
- **Android:** native Tauri app target; verify package signing and playback on your device before release
- **macOS:** not yet packaged or playback-validated
- **Spotify:** metadata and playlist import are not included in this version

## Credits and notices

- [Tauri](https://tauri.app/) desktop framework
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) for public YouTube stream resolution
- [Musify](https://github.com/gokadzev/Musify) for upstream catalog metadata
- [Audius](https://docs.audius.co/), [Jamendo](https://developer.jamendo.com/v3.0/tracks), [Internet Archive](https://archive.org/developers/metadata.html), [Quran.com](https://api-docs.quran.com/docs/quickstart/), and [EveryAyah](https://everyayah.com/)

Third-party recordings and upstream catalogs remain subject to their original licenses and availability terms.

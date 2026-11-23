mod database;
mod local;
mod matching;
mod models;
mod providers;

use database::Database;
use models::{Download, Library, Playlist, ProviderResult, Track};
use serde_json::{json, Value};
use std::{
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

struct DownloadQueue(Arc<tokio::sync::Semaphore>);
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
fn new_id() -> String {
    format!(
        "{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}
fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        if let Ok(path) = std::env::var("SOUNDSPHERE_TEST_DATA_DIR") {
            return Ok(PathBuf::from(path));
        }
    }
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_library(db: tauri::State<'_, Database>) -> Result<Library, String> {
    db.library()
}

#[tauri::command]
fn runtime_info(app: tauri::AppHandle) -> Result<Value, String> {
    Ok(
        json!({"version": env!("CARGO_PKG_VERSION"), "testMode": cfg!(debug_assertions) && std::env::var("SOUNDSPHERE_TEST_DATA_DIR").is_ok(), "dataDirectory": data_dir(&app)?}),
    )
}

#[tauri::command]
async fn search_provider(
    provider: String,
    query: String,
    db: tauri::State<'_, Database>,
) -> Result<ProviderResult, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(ProviderResult {
            provider,
            tracks: vec![],
            error: None,
            cached: false,
            needs_configuration: false,
        });
    }
    let jamendo_id = if provider == "jamendo" {
        std::env::var("JAMENDO_CLIENT_ID")
            .ok()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or(db.library()?.jamendo_client_id)
    } else {
        String::new()
    };
    if provider == "jamendo" && jamendo_id.trim().is_empty() {
        return Ok(ProviderResult {
            provider,
            tracks: vec![],
            error: Some(
                "Optional provider. Add your Jamendo developer client ID in Settings.".into(),
            ),
            cached: false,
            needs_configuration: true,
        });
    }
    let key = format!("search:{provider}:{}", query.to_lowercase());
    if let Some(cached) = db.cached(&key) {
        let mut tracks: Vec<Track> = serde_json::from_value(cached).map_err(|e| e.to_string())?;
        #[cfg(target_os = "windows")]
        for track in &mut tracks {
            providers::youtube_audio::add_audio_source(track);
        }
        db.remember(&tracks)?;
        return Ok(ProviderResult {
            provider,
            tracks,
            error: None,
            cached: true,
            needs_configuration: false,
        });
    }
    let result = match provider.as_str() {
        "audius" => providers::audius::search(query).await,
        "archive" => providers::archive::search(query).await,
        "youtube" => providers::youtube::search(query).await,
        "jamendo" => providers::jamendo::search(query, &jamendo_id).await,
        "local" => Ok(db
            .library()?
            .tracks
            .into_iter()
            .filter(|t| {
                format!(
                    "{} {} {}",
                    t.title,
                    t.artist,
                    t.album.as_deref().unwrap_or("")
                )
                .to_lowercase()
                .contains(&query.to_lowercase())
            })
            .collect()),
        _ => Err("Unknown provider".into()),
    };
    match result {
        Ok(tracks) => {
            let tracks = matching::deduplicate(tracks);
            db.remember(&tracks)?;
            db.cache(&key, &tracks, 8)?;
            Ok(ProviderResult {
                provider,
                tracks,
                error: None,
                cached: false,
                needs_configuration: false,
            })
        }
        Err(error) => Ok(ProviderResult {
            provider,
            tracks: vec![],
            error: Some(error),
            cached: false,
            needs_configuration: false,
        }),
    }
}

#[tauri::command]
fn merge_tracks(
    mut tracks: Vec<Track>,
    db: tauri::State<'_, Database>,
) -> Result<Vec<Track>, String> {
    tracks.sort_by(|a, b| a.id.cmp(&b.id));
    let saved = db.library()?.tracks;
    let tracks: Vec<Track> = matching::deduplicate(tracks)
        .into_iter()
        .map(|track| {
            if let Some(existing) = saved.iter().find(|t| matching::same_recording(t, &track)) {
                matching::deduplicate(vec![existing.clone(), track]).remove(0)
            } else {
                track
            }
        })
        .collect();
    db.remember(&tracks)?;
    Ok(tracks)
}

#[tauri::command]
async fn musify_catalog(
    db: tauri::State<'_, Database>,
) -> Result<providers::musify::Catalog, String> {
    if let Some(value) = db.cached("musify:catalog:v1") {
        return serde_json::from_value(value).map_err(|e| e.to_string());
    }
    let catalog = providers::musify::catalog().await?;
    db.remember(&catalog.radio)?;
    db.cache("musify:catalog:v1", &catalog, 3600)?;
    Ok(catalog)
}

#[tauri::command]
async fn musify_collection(
    collection_id: String,
    db: tauri::State<'_, Database>,
) -> Result<Track, String> {
    let catalog = musify_catalog(db.clone()).await?;
    let collection = catalog
        .collections
        .iter()
        .find(|c| c.id == collection_id)
        .ok_or("Collection link not found. Refresh the catalog.")?;
    let (kind, id, _) = providers::youtube::link(&collection.url)?;
    let track = providers::youtube::track(
        &kind,
        &id,
        &collection.title,
        "Musify · YouTube playlist",
        collection.image.clone(),
        None,
    );
    db.remember(std::slice::from_ref(&track))?;
    Ok(track)
}

#[tauri::command]
async fn resolve_youtube_link(
    url: String,
    db: tauri::State<'_, Database>,
) -> Result<Track, String> {
    let track = providers::youtube::resolve(&url).await?;
    db.remember(std::slice::from_ref(&track))?;
    Ok(track)
}

#[tauri::command]
async fn youtube_playlist(
    track_id: String,
    app: tauri::AppHandle,
    db: tauri::State<'_, Database>,
) -> Result<Value, String> {
    let track = db.track(&track_id)?;
    let source = track
        .sources
        .iter()
        .find(|s| s.youtube_kind.as_deref() == Some("playlist"))
        .ok_or("Choose a YouTube playlist.")?;
    let data = providers::youtube_audio::playlist(&app, &source.url).await?;
    let tracks: Vec<Track> =
        serde_json::from_value(data["tracks"].clone()).map_err(|e| e.to_string())?;
    db.remember(&tracks)?;
    Ok(data)
}

#[tauri::command]
fn open_link(url: String, app: tauri::AppHandle) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || ![
            Some("www.youtube.com"),
            Some("music.youtube.com"),
            Some("youtu.be"),
            Some("github.com"),
        ]
        .contains(&parsed.host_str())
    {
        return Err(
            "Only official HTTPS YouTube or source-repository links can be opened here.".into(),
        );
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn quran_catalog(db: tauri::State<'_, Database>) -> Result<Value, String> {
    if let Some(v) = db.cached("quran:catalog") {
        return Ok(v);
    }
    let v = providers::quran::catalog().await?;
    db.cache("quran:catalog", &v, 86400)?;
    Ok(v)
}

#[tauri::command]
async fn quran_tracks(
    chapter: u32,
    reciter: u32,
    mode: String,
    ayah: u32,
    juz: u32,
    db: tauri::State<'_, Database>,
) -> Result<Vec<Track>, String> {
    let key = format!("quran:{mode}:{chapter}:{reciter}:{ayah}:{juz}");
    if let Some(v) = db.cached(&key) {
        return serde_json::from_value(v).map_err(|e| e.to_string());
    }
    let tracks = providers::quran::tracks(chapter, reciter, &mode, ayah, juz).await?;
    db.remember(&tracks)?;
    db.cache(&key, &tracks, 3600)?;
    Ok(tracks)
}

#[tauri::command]
fn library_action(
    action: String,
    track: Option<Track>,
    id: Option<String>,
    name: Option<String>,
    db: tauri::State<'_, Database>,
) -> Result<Library, String> {
    if let Some(t) = &track {
        db.remember(std::slice::from_ref(t))?;
    }
    let id = id.unwrap_or_default();
    let name = name.unwrap_or_default();
    db.update(|l| {
        if let Some(t) = &track {
            if let Some(existing) = l.tracks.iter_mut().find(|a| a.id == t.id) {
                let mut all = existing.clone();
                for source in &t.sources {
                    if !all.sources.iter().any(|s| s.id == source.id) {
                        all.sources.push(source.clone());
                    }
                }
                *existing = all;
            } else {
                l.tracks.push(t.clone());
            }
        }
        match action.as_str() {
            "save" => {}
            "remove" => {
                l.tracks.retain(|t| t.id != id);
                l.favorites.retain(|t| t != &id);
                l.preferences.remove(&id);
                for p in &mut l.playlists {
                    p.track_ids.retain(|t| t != &id);
                }
            }
            "favorite" => {
                if l.favorites.contains(&id) {
                    l.favorites.retain(|t| t != &id);
                } else {
                    l.favorites.push(id);
                }
            }
            "playlist_create" => {
                if name.trim().is_empty() {
                    return Err("Give the playlist a name.".into());
                }
                l.playlists.push(Playlist {
                    id: new_id(),
                    name: name.trim().to_string(),
                    track_ids: vec![],
                });
            }
            "playlist_delete" => l.playlists.retain(|p| p.id != id),
            "playlist_add" => {
                let t = track.as_ref().ok_or("Choose a track first")?;
                let p = l
                    .playlists
                    .iter_mut()
                    .find(|p| p.id == id)
                    .ok_or("Playlist not found")?;
                if !p.track_ids.contains(&t.id) {
                    p.track_ids.push(t.id.clone());
                }
            }
            "playlist_remove" => {
                if let Some(p) = l.playlists.iter_mut().find(|p| p.id == id) {
                    p.track_ids.retain(|t| t != &name);
                }
            }
            "preference" => {
                l.preferences.insert(id, name);
            }
            "settings" => l.jamendo_client_id = name.trim().to_string(),
            "cancel_download" => {
                if let Some(d) = l
                    .downloads
                    .iter_mut()
                    .find(|d| d.id == id && ["queued", "downloading"].contains(&d.status.as_str()))
                {
                    d.status = "cancelled".into();
                }
            }
            _ => return Err("Unknown library action".into()),
        }
        Ok(())
    })
}

#[tauri::command]
async fn import_audio(paths: Vec<String>, app: tauri::AppHandle) -> Result<Value, String> {
    let (tracks, errors) = tauri::async_runtime::spawn_blocking(move || local::scan(paths))
        .await
        .map_err(|e| e.to_string())?;
    for t in &tracks {
        for s in &t.sources {
            if let Some(p) = &s.local_path {
                app.asset_protocol_scope()
                    .allow_file(p)
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    let db = app.state::<Database>();
    db.remember(&tracks)?;
    let library = db.update(|l| {
        l.tracks.extend(tracks.clone());
        l.tracks = matching::deduplicate(std::mem::take(&mut l.tracks));
        Ok(())
    })?;
    Ok(json!({"library": library, "imported": tracks.len(), "errors": errors}))
}

#[tauri::command]
async fn check_source(
    track_id: String,
    source_id: String,
    refresh: Option<bool>,
    app: tauri::AppHandle,
    db: tauri::State<'_, Database>,
) -> Result<Value, String> {
    let track = db.track(&track_id)?;
    let source = track
        .sources
        .iter()
        .find(|s| s.id == source_id)
        .ok_or("Source not found")?;
    if source.provider == "youtube_audio" || source.provider == "youtube" {
        if source.youtube_kind.as_deref() == Some("playlist") {
            return Err("Load the playlist's song queue first.".into());
        }
        let id = source
            .youtube_id
            .as_deref()
            .ok_or("YouTube video ID is missing.")?;
        let value = providers::youtube_audio::media(
            &app,
            id,
            refresh.unwrap_or(false),
            source.provider == "youtube",
        )
        .await?;
        let url = value["url"]
            .as_str()
            .ok_or("YouTube did not return audio.")?;
        let mut response = providers::client()?
            .get(url)
            .header("Range", "bytes=0-1023")
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?
            .error_for_status()
            .map_err(|e| e.without_url().to_string())?;
        if response.chunk().await.map_err(|e| e.to_string())?.is_none() {
            return Err("YouTube returned an empty audio stream.".into());
        }
        return Ok(value);
    }
    if let Some(path) = &source.local_path {
        return if PathBuf::from(path).is_file() {
            Ok(json!({"ok":true}))
        } else {
            Err("Local audio file has moved or is unavailable. Import it again.".into())
        };
    }
    if !source.url.starts_with("https://") {
        return Err("Only secure provider audio URLs are supported.".into());
    }
    let mut r = providers::client()?
        .get(&source.url)
        .header("Range", "bytes=0-1023")
        .timeout(Duration::from_secs(9))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let content = r
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if content.contains("text/html") || content.contains("application/json") {
        return Err("Provider returned a web page instead of playable audio.".into());
    }
    if r.chunk().await.map_err(|e| e.to_string())?.is_none() {
        return Err("Provider returned an empty stream.".into());
    }
    Ok(json!({"ok":true}))
}

fn update_download(app: &tauri::AppHandle, download: &Download) -> Result<(), String> {
    app.state::<Database>().update(|l| {
        if let Some(d) = l.downloads.iter_mut().find(|d| d.id == download.id) {
            *d = download.clone();
        }
        Ok(())
    })?;
    let _ = app.emit("download-progress", download);
    Ok(())
}
fn cancelled(app: &tauri::AppHandle, id: &str) -> bool {
    app.state::<Database>().library().ok().is_some_and(|l| {
        l.downloads
            .iter()
            .any(|d| d.id == id && d.status == "cancelled")
    })
}
#[tauri::command]
async fn download_track(
    track_id: String,
    source_id: String,
    app: tauri::AppHandle,
) -> Result<Download, String> {
    let db = app.state::<Database>();
    let mut track = db.track(&track_id)?;
    let source = track
        .sources
        .iter()
        .find(|s| s.id == source_id)
        .ok_or("Source not found")?
        .clone();
    if !source.downloadable {
        return Err("This source does not grant offline downloads.".into());
    }
    let url = source
        .download_url
        .as_ref()
        .filter(|s| s.starts_with("https://"))
        .ok_or("No permitted download URL")?
        .clone();
    let mut d = Download {
        id: new_id(),
        track_id: track_id.clone(),
        source_id,
        title: track.title.clone(),
        status: "queued".into(),
        bytes: 0,
        total: None,
        error: None,
        path: None,
    };
    db.update(|l| {
        if l.downloads.iter().any(|x| {
            x.track_id == track_id && ["queued", "downloading"].contains(&x.status.as_str())
        }) {
            return Err("This track is already in the download queue.".into());
        }
        l.downloads.push(d.clone());
        Ok(())
    })?;
    let _ = app.emit("download-progress", &d);
    let semaphore = app.state::<DownloadQueue>().0.clone();
    let _permit = semaphore.acquire().await.map_err(|e| e.to_string())?;
    let directory = data_dir(&app)?.join("downloads");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let file = directory.join(format!("{}.mp3", d.id));
    let partial = directory.join(format!("{}.part", d.id));
    let result: Result<(), String> = async {
        if cancelled(&app, &d.id) {
            return Err("Cancelled".into());
        }
        d.status = "downloading".into();
        update_download(&app, &d)?;
        let client = reqwest::Client::builder()
            .user_agent("SoundSphere/0.1")
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(600))
            .build()
            .map_err(|e| e.to_string())?;
        let mut response = client
            .get(&url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let content = response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        if content.contains("text/html") || content.contains("application/json") {
            return Err("Download URL returned no audio.".into());
        }
        d.total = response.content_length();
        if d.total.is_some_and(|n| n > 500_000_000) {
            return Err("This file exceeds the 500 MB download limit.".into());
        }
        let mut output = std::fs::File::create(&partial).map_err(|e| e.to_string())?;
        let mut last = Instant::now();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if cancelled(&app, &d.id) {
                return Err("Cancelled".into());
            }
            d.bytes += chunk.len() as u64;
            if d.bytes > 500_000_000 {
                return Err("Download exceeded 500 MB.".into());
            }
            output.write_all(&chunk).map_err(|e| e.to_string())?;
            if last.elapsed() > Duration::from_millis(600) {
                update_download(&app, &d)?;
                last = Instant::now();
            }
        }
        if d.bytes == 0 {
            return Err("Download was empty.".into());
        }
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        if cancelled(&app, &d.id) {
            return Err("Cancelled".into());
        }
        std::fs::rename(&partial, &file).map_err(|e| e.to_string())?;
        app.asset_protocol_scope()
            .allow_file(&file)
            .map_err(|e| e.to_string())?;
        let mut local_source = source.clone();
        local_source.id = format!("download:{}", d.id);
        local_source.provider = "local".into();
        local_source.label = "Offline download".into();
        local_source.local_path = Some(file.to_string_lossy().into());
        local_source.url = String::new();
        local_source.downloadable = false;
        local_source.download_url = None;
        track.sources.insert(0, local_source);
        db.remember(std::slice::from_ref(&track))?;
        db.update(|l| {
            if let Some(t) = l.tracks.iter_mut().find(|t| t.id == track.id) {
                *t = track.clone();
            } else {
                l.tracks.push(track.clone());
            }
            Ok(())
        })?;
        d.status = "completed".into();
        d.path = Some(file.to_string_lossy().into());
        Ok(())
    }
    .await;
    if let Err(error) = result {
        let _ = std::fs::remove_file(&partial);
        d.status = if error == "Cancelled" {
            "cancelled".into()
        } else {
            "failed".into()
        };
        d.error = Some(error);
    }
    update_download(&app, &d)?;
    Ok(d)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = data_dir(app.handle()).map_err(std::io::Error::other)?;
            std::fs::create_dir_all(&dir)?;
            let db =
                Database::open(&dir.join("soundsphere.sqlite")).map_err(std::io::Error::other)?;
            let library = db
                .update(|l| {
                    for track in &mut l.tracks {
                        if providers::youtube_audio::add_audio_source(track) {
                            l.preferences.remove(&track.id);
                        }
                    }
                    for d in &mut l.downloads {
                        if ["queued", "downloading"].contains(&d.status.as_str()) {
                            d.status = "failed".into();
                            d.error = Some(
                                "Interrupted when the app closed. Retry to download again.".into(),
                            );
                        }
                    }
                    Ok(())
                })
                .map_err(std::io::Error::other)?;
            for t in &library.tracks {
                for s in &t.sources {
                    if let Some(path) = &s.local_path {
                        let _ = app.asset_protocol_scope().allow_file(path);
                    }
                }
            }
            db.remember(&library.tracks)
                .map_err(std::io::Error::other)?;
            app.manage(db);
            app.manage(DownloadQueue(Arc::new(tokio::sync::Semaphore::new(1))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            musify_catalog,
            musify_collection,
            resolve_youtube_link,
            youtube_playlist,
            open_link,
            runtime_info,
            get_library,
            search_provider,
            merge_tracks,
            quran_catalog,
            quran_tracks,
            library_action,
            import_audio,
            check_source,
            download_track
        ])
        .run(tauri::generate_context!())
        .expect("error while running SoundSphere");
}

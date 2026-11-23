use crate::{database::now, models::Track};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::Manager;

static CACHE: OnceLock<Mutex<HashMap<String, (u64, Value)>>> = OnceLock::new();
static SLOTS: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
static RUNTIME: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

#[cfg(target_os = "windows")]
fn install_runtime(directory: PathBuf) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    let mut ready = RUNTIME
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some(path) = ready.as_ref() {
        return Ok(path.clone());
    }
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let files: [(&str, &[u8], &str); 1] = [(
        "yt-dlp.exe",
        include_bytes!("../../resources/youtube/yt-dlp.exe"),
        "f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d",
    )];
    for (name, bytes, expected) in files {
        let path = directory.join(name);
        let valid = std::fs::read(&path).ok().is_some_and(|data| {
            Sha256::digest(&data)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
                == expected
        });
        if !valid {
            std::fs::write(&path, bytes)
                .map_err(|e| format!("Could not prepare YouTube audio helper: {e}"))?;
        }
    }
    for (name, text) in [
        (
            "NOTICE.txt",
            include_str!("../../resources/youtube/NOTICE.txt"),
        ),
        (
            "yt-dlp-LICENSE.txt",
            include_str!("../../resources/youtube/yt-dlp-LICENSE.txt"),
        ),
        (
            "yt-dlp-THIRD-PARTY.txt",
            include_str!("../../resources/youtube/yt-dlp-THIRD-PARTY.txt"),
        ),
        (
            "GPL-3.0.txt",
            include_str!("../../resources/youtube/GPL-3.0.txt"),
        ),
    ] {
        std::fs::write(directory.join(name), text).map_err(|e| e.to_string())?;
    }
    *ready = Some(directory.clone());
    Ok(directory)
}

#[cfg(not(target_os = "windows"))]
fn install_runtime(_: PathBuf) -> Result<PathBuf, String> {
    Err("YouTube audio mode is currently available in the Windows build.".into())
}

async fn extract(
    app: &tauri::AppHandle,
    url: &str,
    playlist: bool,
    video: bool,
) -> Result<Value, String> {
    let _permit = SLOTS
        .get_or_init(|| tokio::sync::Semaphore::new(2))
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("youtube-audio-2026.10.26");
    let directory = tauri::async_runtime::spawn_blocking(move || install_runtime(directory))
        .await
        .map_err(|e| e.to_string())??;
    let mut command = tokio::process::Command::new(directory.join("yt-dlp.exe"));
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    command
        .current_dir(&directory)
        .kill_on_drop(true)
        .args([
            "--ignore-config",
            "--no-plugin-dirs",
            "--no-remote-components",
            "--no-js-runtimes",
            "--extractor-args",
            "youtube:player_client=visionos",
        ])
        .args([
            "--socket-timeout",
            "10",
            "--retries",
            "1",
            "--extractor-retries",
            "1",
            "--no-warnings",
            "--skip-download",
            "--dump-single-json",
        ]);
    if playlist {
        command.args([
            "--flat-playlist",
            "--playlist-start",
            "1",
            "--playlist-end",
            "100",
        ]);
    } else {
        command.args([
            "--no-playlist",
            "--format",
            if video {
                "bestvideo[ext=mp4][vcodec^=avc1][height<=1080][protocol=https]+bestaudio[ext=m4a][protocol=https]"
            } else {
                "bestaudio[ext=m4a][protocol=https]/bestaudio[protocol=https]"
            },
        ]);
    }
    let output = tokio::time::timeout(Duration::from_secs(45), command.arg("--").arg(url).output())
        .await
        .map_err(|_| "YouTube audio took too long to respond. Retry this source.".to_string())?
        .map_err(|e| format!("Could not start YouTube audio: {e}"))?;
    if !output.status.success() {
        let diagnostic = String::from_utf8_lossy(&output.stderr);
        let line = diagnostic
            .lines()
            .rev()
            .find(|s| s.contains("ERROR:"))
            .unwrap_or("YouTube audio is unavailable for this link.");
        return Err(format!(
            "YouTube audio: {}",
            line.chars().take(500).collect::<String>()
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| "YouTube audio returned an unreadable response. Retry this source.".into())
}

fn valid_stream_url(value: &str) -> bool {
    reqwest::Url::parse(value).ok().is_some_and(|url| {
        url.scheme() == "https"
            && url
                .host_str()
                .is_some_and(|host| host == "googlevideo.com" || host.ends_with(".googlevideo.com"))
    })
}

pub async fn media(
    app: &tauri::AppHandle,
    video_id: &str,
    refresh: bool,
    video: bool,
) -> Result<Value, String> {
    let (_, id, url) =
        super::youtube::link(&format!("https://www.youtube.com/watch?v={video_id}"))?;
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let cache_key = format!("{id}:{}", if video { "video" } else { "audio" });
    if !refresh {
        if let Some((expires, value)) = cache.lock().map_err(|e| e.to_string())?.get(&cache_key) {
            if *expires > now() {
                return Ok(value.clone());
            }
        }
    }
    let data = extract(app, &url, false, video).await?;
    let formats = data["requested_formats"].as_array();
    let audio_data = if video {
        formats
            .and_then(|items| items.iter().find(|item| item["vcodec"] == "none"))
            .ok_or("YouTube returned no playable audio stream.")?
    } else {
        &data
    };
    let stream = audio_data["url"]
        .as_str()
        .filter(|url| valid_stream_url(url))
        .ok_or("YouTube returned no playable audio stream.")?;
    let mut value = json!({"ok":true,"url":stream,"duration":data["duration"],"format":audio_data["ext"],"videoId":id});
    if video {
        let video_data = formats
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item["vcodec"].as_str().is_some_and(|codec| codec != "none"))
            })
            .ok_or("YouTube returned no playable video stream.")?;
        let url = video_data["url"]
            .as_str()
            .filter(|url| valid_stream_url(url))
            .ok_or("YouTube returned an invalid video stream.")?;
        value["videoUrl"] = json!(url);
        value["height"] = video_data["height"].clone();
    }
    cache
        .lock()
        .map_err(|e| e.to_string())?
        .insert(cache_key, (now() + 180, value.clone()));
    Ok(value)
}

pub async fn playlist(app: &tauri::AppHandle, input: &str) -> Result<Value, String> {
    let (kind, _, url) = super::youtube::link(input)?;
    if kind != "playlist" {
        return Err("Choose a YouTube playlist link.".into());
    }
    let data = extract(app, &url, true, false).await?;
    let entries = data["entries"]
        .as_array()
        .ok_or("This playlist has no accessible public songs.")?;
    let tracks: Vec<Track> = entries
        .iter()
        .filter_map(|entry| {
            let id = entry["id"].as_str()?;
            super::youtube::link(&format!("https://www.youtube.com/watch?v={id}")).ok()?;
            let title = entry["title"].as_str()?;
            if title == "[Private video]" || title == "[Deleted video]" {
                return None;
            }
            let artist = entry["channel"]
                .as_str()
                .or(entry["uploader"].as_str())
                .unwrap_or("YouTube");
            let image = entry["thumbnails"]
                .as_array()
                .and_then(|a| a.last())
                .and_then(|v| v["url"].as_str())
                .map(String::from);
            Some(super::youtube::track(
                "video",
                id,
                title,
                artist,
                image,
                entry["duration"].as_f64().map(|n| n as u32),
            ))
        })
        .collect();
    if tracks.is_empty() {
        return Err("This playlist has no accessible public songs.".into());
    }
    Ok(
        json!({"tracks":tracks,"total":data["playlist_count"].as_u64().unwrap_or(tracks.len() as u64),"limit":100}),
    )
}

pub fn add_audio_source(track: &mut Track) -> bool {
    for source in &mut track.sources {
        if source.provider == "youtube" {
            source.label = "YouTube video".into();
            source.quality = Some("Video + audio · Ad-free playback".into());
        }
    }
    if track.sources.iter().any(|s| s.provider == "youtube_audio") {
        return false;
    }
    let Some(video) = track
        .sources
        .iter()
        .find(|s| s.provider == "youtube" && s.youtube_id.is_some())
        .cloned()
    else {
        return false;
    };
    let mut audio = video;
    audio.provider = "youtube_audio".into();
    audio.id = format!(
        "youtube-audio:{}:{}",
        audio.youtube_kind.as_deref().unwrap_or("video"),
        audio.youtube_id.as_deref().unwrap_or("")
    );
    audio.label = "YouTube audio".into();
    audio.quality = Some("Audio-only playback".into());
    track.sources.insert(0, audio);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn media_hosts_are_checked() {
        assert!(valid_stream_url(
            "https://rr1---sn-test.googlevideo.com/videoplayback"
        ));
        assert!(!valid_stream_url("https://googlevideo.com.evil.test/file"));
        assert!(!valid_stream_url("http://rr1.googlevideo.com/file"));
    }
    #[test]
    fn existing_video_link_gains_one_audio_source() {
        let mut track =
            super::super::youtube::track("video", "a18py61_F_w", "Track", "Artist", None, None);
        add_audio_source(&mut track);
        add_audio_source(&mut track);
        assert_eq!(
            track
                .sources
                .iter()
                .filter(|s| s.provider == "youtube_audio")
                .count(),
            1
        );
        assert!(!track.sources[0].downloadable);
    }
}

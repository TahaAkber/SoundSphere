// Independent metadata adapter. Windows playback resolves public native media streams.
use super::{client, text};
use crate::models::{StreamSource, Track};
use serde_json::Value;
use std::collections::HashSet;

pub fn link(input: &str) -> Result<(String, String, String), String> {
    let input = input.trim();
    let parsed = reqwest::Url::parse(input)
        .map_err(|_| "Paste a YouTube video, Shorts, Music or playlist URL.")?;
    if !["http", "https"].contains(&parsed.scheme())
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Use a public YouTube link.".into());
    }
    let host = parsed.host_str().unwrap_or("");
    if ![
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtu.be",
        "www.youtube-nocookie.com",
    ]
    .contains(&host)
    {
        return Err("This link is not a YouTube URL.".into());
    }
    let params: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
    let path: Vec<_> = parsed.path().trim_matches('/').split('/').collect();
    let video = if host == "youtu.be" {
        path.first().copied()
    } else if ["shorts", "embed", "live"].contains(&path.first().copied().unwrap_or("")) {
        path.get(1).copied().filter(|id| *id != "videoseries")
    } else {
        params.get("v").map(String::as_str)
    };
    if let Some(id) = video {
        if id.len() != 11 || !valid_id(id) {
            return Err("Invalid YouTube video ID.".into());
        }
        return Ok((
            "video".into(),
            id.into(),
            format!("https://www.youtube.com/watch?v={id}"),
        ));
    }
    let id = params
        .get("list")
        .ok_or("This YouTube URL does not identify a video or playlist.")?;
    if !(10..=128).contains(&id.len()) || !valid_id(id) {
        return Err("Invalid YouTube playlist ID.".into());
    }
    Ok((
        "playlist".into(),
        id.into(),
        format!("https://www.youtube.com/playlist?list={id}"),
    ))
}
fn valid_id(value: &str) -> bool {
    value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn track(
    kind: &str,
    id: &str,
    title: &str,
    artist: &str,
    artwork: Option<String>,
    duration: Option<u32>,
) -> Track {
    let url = if kind == "playlist" {
        format!("https://www.youtube.com/playlist?list={id}")
    } else {
        format!("https://www.youtube.com/watch?v={id}")
    };
    let mut source = StreamSource::remote(
        format!("youtube:{kind}:{id}"),
        "youtube",
        "YouTube official player",
        url.clone(),
    );
    source.youtube_id = Some(id.into());
    source.youtube_kind = Some(kind.into());
    source.attribution = Some(url);
    let mut result = Track {
        id: source.id.clone(),
        title: title.into(),
        artist: artist.into(),
        album: Some(if kind == "playlist" {
            "YouTube playlist".into()
        } else {
            "YouTube".into()
        }),
        artwork,
        duration,
        sources: vec![source],
        provider_track_ids: vec![format!("youtube:{kind}:{id}")],
        ..Default::default()
    };
    #[cfg(target_os = "windows")]
    super::youtube_audio::add_audio_source(&mut result);
    result
}

fn initial_data(html: &str) -> Result<Value, String> {
    for marker in [
        "var ytInitialData =",
        "ytInitialData =",
        "window[\"ytInitialData\"] =",
        "var ytInitialData=",
        "ytInitialData=",
        "window[\"ytInitialData\"]=",
    ] {
        if let Some(start) = html.find(marker) {
            let mut values =
                serde_json::Deserializer::from_str(html[start + marker.len()..].trim_start())
                    .into_iter::<Value>();
            if let Some(Ok(value)) = values.next() {
                return Ok(value);
            }
        }
    }
    Err("YouTube search metadata could not be loaded. You can still paste a YouTube link under Musify links.".into())
}
fn label(value: &Value) -> String {
    value["simpleText"]
        .as_str()
        .map(String::from)
        .unwrap_or_else(|| {
            value["runs"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default()
        })
}
fn clock(value: &str) -> Option<u32> {
    value.split(':').try_fold(0u32, |total, n| {
        total.checked_mul(60)?.checked_add(n.parse().ok()?)
    })
}
fn videos(value: &Value, output: &mut Vec<Track>, seen: &mut HashSet<String>) {
    if output.len() >= 25 {
        return;
    }
    match value {
        Value::Object(object) => {
            if let Some(video) = object.get("videoRenderer") {
                if let Some(id) = video["videoId"]
                    .as_str()
                    .filter(|id| id.len() == 11 && valid_id(id))
                {
                    if seen.insert(id.to_string()) {
                        let title = label(&video["title"]);
                        let mut artist = label(&video["ownerText"]);
                        if artist.is_empty() {
                            artist = label(&video["longBylineText"]);
                        }
                        let image = video["thumbnail"]["thumbnails"]
                            .as_array()
                            .and_then(|a| a.last())
                            .and_then(|v| v["url"].as_str())
                            .map(String::from);
                        output.push(track(
                            "video",
                            id,
                            &title,
                            &artist,
                            image,
                            clock(&label(&video["lengthText"])),
                        ));
                    }
                }
            }
            for child in object.values() {
                videos(child, output, seen);
            }
        }
        Value::Array(array) => {
            for child in array {
                videos(child, output, seen);
            }
        }
        _ => {}
    }
}
pub async fn search(query: &str) -> Result<Vec<Track>, String> {
    let response = client()?
        .get("https://www.youtube.com/results")
        .query(&[("search_query", query), ("hl", "en")])
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?
        .error_for_status()
        .map_err(|e| e.without_url().to_string())?;
    let html = response.text().await.map_err(|e| e.to_string())?;
    let data = initial_data(&html)?;
    let mut output = vec![];
    videos(&data, &mut output, &mut HashSet::new());
    Ok(output)
}
pub async fn resolve(input: &str) -> Result<Track, String> {
    let (kind, id, url) = link(input)?;
    if kind == "playlist" {
        let html = client()?
            .get(&url)
            .query(&[("hl", "en")])
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?
            .error_for_status()
            .map_err(|e| e.without_url().to_string())?
            .text()
            .await
            .map_err(|e| e.to_string())?;
        let data = initial_data(&html)?;
        let title = data["metadata"]["playlistMetadataRenderer"]["title"].as_str().ok_or("Playlist metadata is unavailable. It may be private, removed or region restricted.")?;
        return Ok(track(&kind, &id, title, "YouTube playlist", None, None));
    }
    let data: Value = client()?
        .get("https://www.youtube.com/oembed")
        .query(&[("url", url.as_str()), ("format", "json")])
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?
        .error_for_status()
        .map_err(|e| e.without_url().to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(track(
        &kind,
        &id,
        &text(&data["title"]),
        &text(&data["author_name"]),
        data["thumbnail_url"].as_str().map(String::from),
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handles_public_youtube_link_formats() {
        for url in [
            "https://youtu.be/a18py61_F_w?t=3",
            "https://music.youtube.com/watch?v=a18py61_F_w",
            "https://www.youtube.com/shorts/a18py61_F_w",
        ] {
            assert_eq!(link(url).unwrap().1, "a18py61_F_w");
        }
        assert_eq!(
            link("https://www.youtube.com/playlist?list=PL1234567890")
                .unwrap()
                .0,
            "playlist"
        );
        assert!(link("https://youtube.com.evil.test/watch?v=a18py61_F_w").is_err());
        assert!(link("javascript:alert(1)").is_err());
        assert!(link("https://youtube.com/watch?v=bad").is_err());
    }
    #[test]
    fn metadata_extraction_is_json_only() {
        let data =
            initial_data("<script>var ytInitialData = {\"a\":true}; doNotExecute();</script>")
                .unwrap();
        assert_eq!(data["a"], true);
        assert_eq!(clock("1:02:03"), Some(3723));
        assert!(clock("LIVE").is_none());
    }
}

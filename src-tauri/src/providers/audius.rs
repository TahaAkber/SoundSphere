use super::{client, duration, text};
use crate::models::{StreamSource, Track};
use serde_json::Value;

pub async fn search(query: &str) -> Result<Vec<Track>, String> {
    let c = client()?;
    let mut request = c.get("https://api.audius.co/v1/tracks/search").query(&[
        ("query", query),
        ("limit", "30"),
        ("app_name", "SoundSphere"),
    ]);
    if let Ok(key) = std::env::var("AUDIUS_API_KEY") {
        request = request.header("x-api-key", key);
    }
    let response: Value = request
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let data = response["data"]
        .as_array()
        .ok_or("Audius returned an unexpected response")?;
    Ok(data
        .iter()
        .filter(|t| {
            t["is_streamable"].as_bool() != Some(false)
                && t["is_delete"].as_bool() != Some(true)
                && !t["id"].is_null()
        })
        .map(|t| {
            let id = text(&t["id"]);
            let mut source = StreamSource::remote(
                format!("audius:{id}"),
                "audius",
                "Audius",
                format!("https://api.audius.co/v1/tracks/{id}/stream?app_name=SoundSphere"),
            );
            source.attribution = Some(format!("https://audius.co{}", text(&t["permalink"])));
            Track {
                id: format!("audius:{id}"),
                title: text(&t["title"]),
                artist: text(&t["user"]["name"]),
                duration: duration(&t["duration"]),
                artwork: t["artwork"]["480x480"]
                    .as_str()
                    .or(t["artwork"]["150x150"].as_str())
                    .map(String::from),
                isrc: t["isrc"].as_str().map(String::from),
                sources: vec![source],
                provider_track_ids: vec![format!("audius:{id}")],
                ..Default::default()
            }
        })
        .collect())
}

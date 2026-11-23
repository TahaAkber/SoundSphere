use super::{client, duration, text};
use crate::models::{StreamSource, Track};
use serde_json::Value;

pub async fn search(query: &str, client_id: &str) -> Result<Vec<Track>, String> {
    if client_id.trim().is_empty() {
        return Err("Add your Jamendo client ID in Settings to enable this provider.".into());
    }
    let response: Value = client()?
        .get("https://api.jamendo.com/v3.0/tracks/")
        .query(&[
            ("client_id", client_id),
            ("format", "json"),
            ("limit", "30"),
            ("search", query),
            ("audioformat", "mp32"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if response["headers"]["status"].as_str() != Some("success") {
        return Err(format!(
            "Jamendo: {}",
            text(&response["headers"]["error_message"])
        ));
    }
    let data = response["results"]
        .as_array()
        .ok_or("Jamendo returned an unexpected response")?;
    Ok(data
        .iter()
        .filter_map(|t| {
            let url = t["audio"].as_str().filter(|s| s.starts_with("https://"))?;
            let id = text(&t["id"]);
            let mut s =
                StreamSource::remote(format!("jamendo:{id}"), "jamendo", "Jamendo", url.into());
            s.downloadable = t["audiodownload_allowed"].as_bool() == Some(true)
                && t["audiodownload"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("https://"));
            if s.downloadable {
                s.download_url = t["audiodownload"].as_str().map(String::from);
            }
            s.license = t["license_ccurl"].as_str().map(String::from);
            s.attribution = Some(format!("https://www.jamendo.com/track/{id}"));
            Some(Track {
                id: format!("jamendo:{id}"),
                title: text(&t["name"]),
                artist: text(&t["artist_name"]),
                album: t["album_name"].as_str().map(String::from),
                artwork: t["image"].as_str().map(String::from),
                duration: duration(&t["duration"]),
                sources: vec![s],
                provider_track_ids: vec![format!("jamendo:{id}")],
                ..Default::default()
            })
        })
        .collect())
}

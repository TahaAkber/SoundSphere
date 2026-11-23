use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSource {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub url: String,
    #[serde(default)]
    pub downloadable: bool,
    #[serde(default)]
    pub download_url: Option<String>,
    #[serde(default)]
    pub local_path: Option<String>,
    #[serde(default)]
    pub attribution: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub youtube_id: Option<String>,
    #[serde(default)]
    pub youtube_kind: Option<String>,
}
impl StreamSource {
    pub fn remote(id: String, provider: &str, label: &str, url: String) -> Self {
        Self {
            id,
            provider: provider.into(),
            label: label.into(),
            url,
            downloadable: false,
            download_url: None,
            local_path: None,
            attribution: None,
            license: None,
            quality: None,
            youtube_id: None,
            youtube_kind: None,
        }
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub artwork: Option<String>,
    pub duration: Option<u32>,
    pub isrc: Option<String>,
    #[serde(default)]
    pub sources: Vec<StreamSource>,
    #[serde(default)]
    pub provider_track_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub track_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub id: String,
    pub track_id: String,
    pub source_id: String,
    pub title: String,
    pub status: String,
    pub bytes: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
    pub path: Option<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Library {
    pub tracks: Vec<Track>,
    pub favorites: Vec<String>,
    pub playlists: Vec<Playlist>,
    pub preferences: HashMap<String, String>,
    pub downloads: Vec<Download>,
    pub jamendo_client_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResult {
    pub provider: String,
    pub tracks: Vec<Track>,
    pub error: Option<String>,
    pub cached: bool,
    #[serde(default)]
    pub needs_configuration: bool,
}

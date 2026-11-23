// Reads upstream link metadata as data. No Musify application or extraction code is copied/executed.
use super::client;
use crate::models::{StreamSource, Track};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub const SOURCE: &str = "https://github.com/gokadzev/Musify";
const RAW: &str = "https://raw.githubusercontent.com/gokadzev/Musify/master/lib/database";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub url: String,
    pub image: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub collections: Vec<Collection>,
    pub radio: Vec<Track>,
    pub source: String,
    pub license: String,
}

fn quoted(input: &str) -> Option<String> {
    let mut chars = input.trim().chars();
    let quote = chars.next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let mut result = String::new();
    let mut escaped = false;
    for c in chars {
        if escaped {
            result.push(c);
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == quote {
            return Some(result);
        } else {
            result.push(c);
        }
    }
    None
}
fn records(input: &str, start_key: &str) -> Vec<HashMap<String, String>> {
    let mut output = vec![];
    let mut current = HashMap::new();
    let mut pending: Option<String> = None;
    for line in input.lines() {
        let line = line.trim();
        if let Some(key) = pending.take() {
            if let Some(value) = quoted(line) {
                current.insert(key, value);
                continue;
            }
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim().trim_matches(['\'', '"']);
            if !["ytid", "title", "image", "id", "name", "streamUrl", "genre"].contains(&key) {
                continue;
            }
            if key == start_key && current.contains_key(start_key) {
                output.push(std::mem::take(&mut current));
            }
            if let Some(value) = quoted(value) {
                current.insert(key.to_string(), value);
            } else if value.trim().is_empty() {
                pending = Some(key.to_string());
            }
        }
    }
    if !current.is_empty() {
        output.push(current);
    }
    output
}
fn collections(input: &str, kind: &str) -> Vec<Collection> {
    records(input, "ytid")
        .into_iter()
        .filter_map(|mut record| {
            let id = record.remove("ytid")?;
            let title = record.remove("title")?;
            let url = format!("https://www.youtube.com/playlist?list={id}");
            super::youtube::link(&url).ok()?;
            Some(Collection {
                id: format!("musify:{id}"),
                title,
                kind: kind.into(),
                url,
                image: record.remove("image").filter(|s| s.starts_with("https://")),
            })
        })
        .collect()
}
fn radio(input: &str) -> Vec<Track> {
    records(input, "id")
        .into_iter()
        .filter_map(|mut record| {
            let id = record.remove("id")?;
            let title = record.remove("name")?;
            let url = record.remove("streamUrl")?;
            if !url.starts_with("https://") {
                return None;
            }
            let mut source =
                StreamSource::remote(format!("musify:radio:{id}"), "radio", &title, url);
            source.quality = Some("Live radio".into());
            source.attribution = Some(format!(
                "{SOURCE}/blob/master/lib/database/radio_stations.db.dart"
            ));
            Some(Track {
                id: source.id.clone(),
                title,
                artist: record
                    .remove("genre")
                    .unwrap_or_else(|| "Radio station".into()),
                album: Some("Musify radio links".into()),
                artwork: record.remove("image"),
                sources: vec![source],
                ..Default::default()
            })
        })
        .collect()
}
pub async fn catalog() -> Result<Catalog, String> {
    let c = client()?;
    async fn download(c: &reqwest::Client, file: &str) -> Result<String, String> {
        c.get(format!("{RAW}/{file}.db.dart"))
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?
            .error_for_status()
            .map_err(|e| e.without_url().to_string())?
            .text()
            .await
            .map_err(|e| e.to_string())
    }
    let (p, a, r) = tokio::join!(
        download(&c, "playlists"),
        download(&c, "albums"),
        download(&c, "radio_stations")
    );
    let mut entries = collections(&p?, "playlist");
    entries.extend(collections(&a?, "album"));
    let radio = radio(&r?);
    let mut seen = HashSet::new();
    entries.retain(|e| seen.insert(e.id.clone()));
    if entries.is_empty() {
        return Err("Musify's link catalog format changed or could not be read. You can still paste a YouTube link.".into());
    }
    Ok(Catalog {
        collections: entries,
        radio,
        source: SOURCE.into(),
        license: "GPL-3.0-or-later — upstream link metadata by Valeri Gokadze / Musify".into(),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn data_parser_handles_multiline_and_quotes_without_execution() {
        let data = "{'ytid': 'PL1234567890',\n 'title': \"Artist's album\",\n'image':\n 'https://example.com/cover.jpg',\n},\n {'ytid': 'PL9876543210',\n 'title': 'Second',\n},";
        // Upstream fields are line-separated, with the opening brace on its own line.
        let data = data.replace("{'ytid'", "\n'ytid'");
        let result = collections(&data, "album");
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].title, "Artist's album");
        assert!(result[0].image.is_some());
    }
}

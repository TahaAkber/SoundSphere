use super::{client, duration, text};
use crate::models::{StreamSource, Track};
use serde_json::Value;
use std::collections::HashMap;
use std::{error::Error, sync::Arc, time::Duration};

fn search_query(input: &str) -> Option<String> {
    let mut words: Vec<String> = input
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .take(12)
        .map(str::to_lowercase)
        .collect();
    if words.len() > 2 {
        words.retain(|w| w != "e" && w != "o");
    }
    if words.is_empty() {
        return None;
    }
    let mut variants = vec![words.clone()];
    // Transliteration often splits one word, e.g. Taj Dar / Tajdar or New York / NewYork.
    for i in 0..words.len().saturating_sub(1).min(5) {
        let mut joined = words.clone();
        joined[i] = format!("{}{}", joined[i], joined[i + 1]);
        joined.remove(i + 1);
        variants.push(joined);
    }
    let expressions = variants
        .iter()
        .map(|terms| {
            let fields = terms
                .iter()
                .map(|w| format!("(title:\"{w}\" OR creator:\"{w}\")"))
                .collect::<Vec<_>>()
                .join(" AND ");
            format!("({fields})")
        })
        .collect::<Vec<_>>()
        .join(" OR ");
    Some(format!(
        "mediatype:audio AND ({expressions}) AND licenseurl:*creativecommons.org*"
    ))
}

fn request_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        return "Internet Archive timed out. Please retry; other providers can still be used."
            .into();
    }
    if let Some(status) = error.status() {
        return if status.as_u16() == 429 {
            "Internet Archive is rate limiting requests. Wait briefly, then retry.".into()
        } else {
            format!(
                "Internet Archive returned HTTP {}. Please retry later.",
                status.as_u16()
            )
        };
    }
    let error = error.without_url();
    let mut detail: &dyn Error = &error;
    while let Some(source) = detail.source() {
        detail = source;
    }
    format!("Could not connect to Internet Archive: {detail}. Check your connection and retry.")
}

async fn archive_json(
    c: &reqwest::Client,
    url: &str,
    params: &[(&str, &str)],
) -> Result<Value, String> {
    let mut last = String::new();
    for attempt in 0..3 {
        // A fresh HTTP/1.1 connection on the last attempt also handles transient HTTP/2 resets.
        let fallback;
        let selected = if attempt == 2 {
            fallback = reqwest::Client::builder()
                .user_agent("SoundSphere/0.1 (personal audio player)")
                .http1_only()
                .connect_timeout(Duration::from_secs(6))
                .build()
                .map_err(|e| e.to_string())?;
            &fallback
        } else {
            c
        };
        let result = async {
            selected
                .get(url)
                .query(params)
                .timeout(Duration::from_secs(12 + attempt * 3))
                .send()
                .await?
                .error_for_status()?
                .json::<Value>()
                .await
        }
        .await;
        match result {
            Ok(value) => return Ok(value),
            Err(error) => {
                let retry = error.is_connect()
                    || error.is_request()
                    || error.is_timeout()
                    || error.is_body()
                    || error.is_decode()
                    || error
                        .status()
                        .is_some_and(|s| s.as_u16() == 429 || s.is_server_error());
                last = request_error(error);
                if !retry {
                    break;
                }
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_millis(300 * (attempt + 1))).await;
                }
            }
        }
    }
    Err(last)
}

fn allowed_license(url: &str) -> bool {
    reqwest::Url::parse(url).ok().is_some_and(|u| {
        u.host_str() == Some("creativecommons.org")
            && (u.path().starts_with("/licenses/") || u.path().starts_with("/publicdomain/"))
    })
}
pub async fn search(query: &str) -> Result<Vec<Track>, String> {
    let c = client()?;
    let Some(q) = search_query(query) else {
        return Ok(vec![]);
    };
    let response = archive_json(
        &c,
        "https://archive.org/advancedsearch.php",
        &[
            ("q", q.as_str()),
            ("output", "json"),
            ("rows", "6"),
            ("fl[]", "identifier"),
        ],
    )
    .await?;
    let docs = response["response"]["docs"]
        .as_array()
        .ok_or("Internet Archive returned an unexpected response")?;
    let mut jobs = tokio::task::JoinSet::new();
    let slots = Arc::new(tokio::sync::Semaphore::new(3));
    for item in docs {
        if let Some(id) = item["identifier"].as_str() {
            let id = id.to_string();
            let c = c.clone();
            let slots = slots.clone();
            jobs.spawn(async move {
                let _permit = slots.acquire().await.map_err(|e| e.to_string())?;
                let data = archive_json(
                    &c,
                    &format!("https://archive.org/metadata/{}", urlencoding::encode(&id)),
                    &[],
                )
                .await?;
                Ok::<_, String>(parse_item(&id, &data))
            });
        }
    }
    let mut tracks = vec![];
    let mut errors = 0;
    while let Some(result) = jobs.join_next().await {
        match result {
            Ok(Ok(mut t)) => tracks.append(&mut t),
            _ => errors += 1,
        }
    }
    if tracks.is_empty() && errors > 0 {
        return Err("Internet Archive item metadata could not be loaded. Try again.".into());
    }
    Ok(tracks)
}
fn parse_item(id: &str, data: &Value) -> Vec<Track> {
    let license = text(&data["metadata"]["licenseurl"]);
    if !allowed_license(&license)
        || data["is_dark"].as_bool() == Some(true)
        || data["metadata"]["access-restricted-item"].as_str() == Some("true")
    {
        return vec![];
    }
    let Some(files) = data["files"].as_array() else {
        return vec![];
    };
    let mut groups: HashMap<String, Vec<&Value>> = HashMap::new();
    for f in files {
        let name = text(&f["name"]);
        if name.to_lowercase().ends_with(".mp3") && f["private"].as_str() != Some("true") {
            let original = f["original"].as_str().unwrap_or(&name).to_string();
            groups.entry(original).or_default().push(f);
        }
    }
    let mut groups: Vec<_> = groups.into_iter().collect();
    groups.sort_by(|a, b| a.0.cmp(&b.0));
    groups
        .into_iter()
        .take(8)
        .map(|(original, files)| {
            let first = files[0];
            let title = first["title"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(&original)
                .trim_end_matches(".mp3")
                .trim_end_matches(".flac")
                .to_string();
            let simple_title = crate::matching::norm(&title);
            let item_title = text(&data["metadata"]["title"]);
            let title = if !item_title.is_empty()
                && simple_title.split_whitespace().all(|w| {
                    w == "track" || w.starts_with("track") || w.chars().all(|c| c.is_ascii_digit())
                }) {
                format!("{item_title} · {title}")
            } else {
                title
            };
            let artist = text(&data["metadata"]["creator"]);
            let sources = files
                .iter()
                .map(|f| {
                    let name = text(&f["name"]);
                    let url = format!(
                        "https://archive.org/download/{}/{}",
                        urlencoding::encode(id),
                        urlencoding::encode(&name)
                    );
                    let mut s = StreamSource::remote(
                        format!("archive:{id}:{name}"),
                        "archive",
                        "Internet Archive",
                        url.clone(),
                    );
                    s.downloadable = true;
                    s.download_url = Some(url);
                    s.license = Some(license.clone());
                    s.attribution = Some(format!("https://archive.org/details/{id}"));
                    s.quality = f["format"].as_str().map(String::from);
                    s
                })
                .collect();
            Track {
                id: format!("archive:{id}:{original}"),
                title,
                artist: if artist.is_empty() {
                    "Unknown artist".into()
                } else {
                    artist
                },
                album: Some(text(&data["metadata"]["title"])),
                duration: duration(&first["length"]),
                artwork: Some(format!("https://archive.org/services/img/{id}")),
                sources,
                provider_track_ids: vec![format!("archive:{id}:{original}")],
                ..Default::default()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transliterated_titles_and_punctuation() {
        let q = search_query("taj dar e haram").unwrap();
        assert!(q.contains("title:\"tajdar\""));
        assert!(q.contains("title:\"haram\""));
        assert!(!q.contains("title:\"e\""));
        assert!(q.contains("licenseurl:*creativecommons.org*"));
        assert!(search_query("!!!").is_none());
        assert!(search_query("Tajdar-e-Haram")
            .unwrap()
            .contains("title:\"tajdar\""));
        assert!(search_query("E").unwrap().contains("title:\"e\""));
    }
    #[tokio::test]
    async fn retries_transient_server_errors() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            for status in [503, 503, 200] {
                let (mut stream, _) = server.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = [0; 4096];
                let _ = stream.read(&mut request).unwrap();
                let body = "{\"ok\":true}";
                write!(stream,"HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let value = archive_json(&client().unwrap(), &format!("http://{address}/test"), &[])
            .await
            .unwrap();
        assert_eq!(value["ok"], true);
        worker.join().unwrap();
    }
    #[test]
    fn license_host_must_be_exact() {
        assert!(allowed_license(
            "https://creativecommons.org/licenses/by/4.0/"
        ));
        assert!(!allowed_license(
            "https://creativecommons.org.evil.test/licenses/by/4.0/"
        ));
        assert!(!allowed_license("https://example.com/audio"));
    }

    #[tokio::test]
    #[ignore = "requires a live Internet Archive connection"]
    async fn transliterated_live_search() {
        let tracks = search("taj dar e haram").await.unwrap();
        assert!(!tracks.is_empty());
        println!(
            "Live transliterated search returned {} licensed audio files",
            tracks.len()
        );
    }
}

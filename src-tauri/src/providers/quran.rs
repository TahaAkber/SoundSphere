use super::{client, json, text};
use crate::models::{StreamSource, Track};
use serde_json::{json as value, Value};

fn base() -> String {
    std::env::var("QURAN_API_BASE_URL")
        .unwrap_or_else(|_| "https://api.quran.com/api/v4".into())
        .trim_end_matches('/')
        .to_string()
}
pub fn chapters() -> Value {
    serde_json::from_str(include_str!("../../data/quran-chapters.json"))
        .expect("bundled official chapter metadata")
}
pub async fn catalog() -> Result<Value, String> {
    let c = client()?;
    let chapters_url = format!("{}/resources/chapter_reciters?language=en", base());
    let verses_url = format!("{}/resources/recitations?language=en", base());
    let (a, b) = tokio::join!(json(&c, &chapters_url), json(&c, &verses_url));
    Ok(
        value!({"chapters": chapters(), "chapterReciters": a?["reciters"], "verseReciters": b?["recitations"]}),
    )
}
fn everyayah_folder(name: &str) -> Option<&'static str> {
    let n = name.to_lowercase();
    if n.contains("alafasy") || n.contains("afasy") {
        Some("Alafasy_128kbps")
    } else if n.contains("sudais") {
        Some("Abdurrahmaan_As-Sudais_192kbps")
    } else if n.contains("husary") && !n.contains("muallim") && !n.contains("mujawwad") {
        Some("Husary_128kbps")
    } else {
        None
    }
}
pub async fn tracks(
    chapter: u32,
    reciter: u32,
    mode: &str,
    ayah: u32,
    juz: u32,
) -> Result<Vec<Track>, String> {
    if !["surah", "ayah", "juz"].contains(&mode)
        || !(1..=114).contains(&chapter)
        || reciter == 0
        || (mode == "juz" && !(1..=30).contains(&juz))
    {
        return Err("Choose a valid Surah, Qari and Juz.".into());
    }
    let c = client()?;
    let catalog = catalog().await?;
    let list = if mode == "surah" {
        "chapterReciters"
    } else {
        "verseReciters"
    };
    let r = catalog[list]
        .as_array()
        .and_then(|a| a.iter().find(|r| r["id"].as_u64() == Some(reciter as u64)))
        .ok_or("Qari is not available for this playback mode")?;
    let name = r["name"]
        .as_str()
        .or(r["reciter_name"].as_str())
        .unwrap_or("Quran reciter");
    let style = r["style"]
        .as_str()
        .or(r["style"]["name"].as_str())
        .unwrap_or("");
    let display_name = if style.is_empty() {
        name.to_string()
    } else {
        format!("{name} · {style}")
    };
    let name = display_name.as_str();
    let chapter_name = catalog["chapters"]
        .as_array()
        .and_then(|a| a.iter().find(|v| v["id"].as_u64() == Some(chapter as u64)))
        .map(|v| text(&v["name_simple"]))
        .unwrap_or_default();
    if mode == "surah" {
        let data = json(
            &c,
            &format!("{}/chapter_recitations/{reciter}/{chapter}", base()),
        )
        .await?;
        let url = data["audio_file"]["audio_url"]
            .as_str()
            .ok_or("No Surah audio returned for this Qari")?;
        let mut source =
            foundation_source(format!("quran:surah:{reciter}:{chapter}"), url.into(), name);
        source.quality = Some("Complete Surah".into());
        return Ok(vec![Track {
            id: source.id.clone(),
            title: format!("Surah {chapter_name}"),
            artist: name.into(),
            album: Some("Quran / Tilawat".into()),
            sources: vec![source],
            ..Default::default()
        }]);
    }
    let route = if mode == "juz" {
        format!("by_juz/{juz}")
    } else {
        format!("by_chapter/{chapter}")
    };
    let mut page = 1;
    let mut output = vec![];
    loop {
        let data = json(
            &c,
            &format!(
                "{}/recitations/{reciter}/{route}?per_page=50&page={page}",
                base()
            ),
        )
        .await?;
        let files = data["audio_files"]
            .as_array()
            .ok_or("Quran audio service returned no verse list")?;
        for file in files {
            let Some(key) = file["verse_key"].as_str() else {
                continue;
            };
            let nums: Vec<u32> = key.split(':').filter_map(|n| n.parse().ok()).collect();
            if nums.len() != 2 || (mode != "juz" && ayah > 0 && nums[1] != ayah) {
                continue;
            }
            let Some(raw) = file["url"].as_str() else {
                continue;
            };
            let url = if raw.starts_with("https://") {
                raw.into()
            } else {
                format!("https://verses.quran.com/{}", raw.trim_start_matches('/'))
            };
            let id = format!("quran:ayah:{reciter}:{key}");
            let mut sources = vec![foundation_source(id.clone(), url, name)];
            if let Some(folder) = everyayah_folder(name) {
                let url = format!(
                    "https://everyayah.com/data/{folder}/{:03}{:03}.mp3",
                    nums[0], nums[1]
                );
                let mut s = StreamSource::remote(
                    format!("everyayah:{folder}:{key}"),
                    "everyayah",
                    "EveryAyah backup",
                    url,
                );
                s.attribution = Some("https://everyayah.com/".into());
                s.quality = Some(folder.rsplit('_').next().unwrap_or_default().into());
                sources.push(s);
            }
            output.push(Track {
                id,
                title: format!("Ayah {key}"),
                artist: name.into(),
                album: Some(format!(
                    "Quran / {}",
                    catalog["chapters"]
                        .as_array()
                        .and_then(|a| a.iter().find(|c| c["id"].as_u64() == Some(nums[0] as u64)))
                        .map(|c| text(&c["name_simple"]))
                        .unwrap_or_default()
                )),
                sources,
                ..Default::default()
            });
        }
        if mode == "ayah" && ayah > 0 && !output.is_empty() {
            break;
        }
        let Some(next) = data["pagination"]["next_page"].as_u64() else {
            break;
        };
        if next <= page || next > 100 {
            return Err("Quran service returned invalid pagination.".into());
        }
        page = next;
    }
    if output.is_empty() {
        return Err("No audio found. Check the Ayah number and chosen reciter.".into());
    }
    Ok(output)
}
fn foundation_source(id: String, url: String, name: &str) -> StreamSource {
    let mut s = StreamSource::remote(id, "quran", "Quran Foundation", url.clone());
    s.downloadable = true;
    s.download_url = Some(url);
    s.attribution = Some("https://quran.com/".into());
    s.license = Some(format!(
        "Quran Foundation Developer Terms · reciter: {name} · personal offline listening"
    ));
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recitation_styles_do_not_share_wrong_backups() {
        assert!(everyayah_folder("Mahmoud Khalil Al-Husary").is_some());
        assert!(everyayah_folder("Mahmoud Khalil Al-Husary · Muallim").is_none());
        assert!(everyayah_folder("Mahmoud Khalil Al-Husary · Mujawwad").is_none());
    }
}

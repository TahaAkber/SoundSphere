use crate::models::{StreamSource, Track};
use lofty::{
    file::{AudioFile, TaggedFileExt},
    probe::Probe,
    tag::{Accessor, ItemKey},
};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

pub fn hash(value: &str) -> String {
    let mut h = DefaultHasher::new();
    value.hash(&mut h);
    format!("{:016x}", h.finish())
}
pub fn scan(paths: Vec<String>) -> (Vec<Track>, Vec<String>) {
    let mut files = vec![];
    let mut errors = vec![];
    for p in paths {
        let p = PathBuf::from(p);
        if p.is_dir() {
            for entry in WalkDir::new(p).follow_links(false).into_iter().take(20000) {
                match entry {
                    Ok(e) if e.file_type().is_file() && supported(e.path()) => {
                        files.push(e.into_path())
                    }
                    Err(e) => errors.push(e.to_string()),
                    _ => {}
                }
            }
        } else {
            files.push(p);
        }
    }
    files.sort();
    files.dedup();
    let mut tracks = vec![];
    for file in files {
        match read(&file) {
            Ok(t) => tracks.push(t),
            Err(e) => errors.push(e),
        }
    }
    (tracks, errors)
}
fn supported(p: &Path) -> bool {
    p.extension().and_then(|s| s.to_str()).is_some_and(|s| {
        ["mp3", "flac", "wav", "ogg", "m4a", "aac", "opus", "aiff"]
            .contains(&s.to_lowercase().as_str())
    })
}
pub fn read(path: &Path) -> Result<Track, String> {
    if !supported(path) {
        return Err(format!("Unsupported audio file: {}", path.display()));
    }
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    let file = Probe::open(&path)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let tag = file.primary_tag().or_else(|| file.first_tag());
    let title = tag
        .and_then(|t| t.title())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into()
        });
    let artist = tag
        .and_then(|t| t.artist())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "Unknown artist".into());
    let path_string = path.to_string_lossy().to_string();
    let id = format!("local:{}", hash(&path_string));
    let mut source = StreamSource::remote(id.clone(), "local", "Local file", String::new());
    source.local_path = Some(path_string);
    source.quality = path.extension().map(|s| s.to_string_lossy().to_uppercase());
    Ok(Track {
        id,
        title,
        artist,
        duration: Some(file.properties().duration().as_secs() as u32),
        album: tag.and_then(|t| t.album()).map(|s| s.to_string()),
        isrc: tag
            .and_then(|t| t.get_string(&ItemKey::Isrc))
            .map(String::from),
        sources: vec![source],
        ..Default::default()
    })
}

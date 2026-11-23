use crate::models::Track;
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

pub fn norm(s: &str) -> String {
    s.nfd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn versions(title: &str) -> Vec<String> {
    norm(title)
        .split_whitespace()
        .filter(|v| {
            [
                "live",
                "remix",
                "cover",
                "acoustic",
                "instrumental",
                "remaster",
                "remastered",
                "extended",
                "karaoke",
            ]
            .contains(v)
        })
        .map(String::from)
        .collect()
}
pub fn same_recording(a: &Track, b: &Track) -> bool {
    if a.id == b.id
        || a.sources.iter().any(|x| {
            b.sources.iter().any(|y| {
                (!x.url.is_empty() && x.url == y.url)
                    || (x.local_path.is_some() && x.local_path == y.local_path)
            })
        })
    {
        return true;
    }
    if versions(&a.title) != versions(&b.title) {
        return false;
    }
    let code = |t: &Track| {
        t.isrc
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_uppercase)
    };
    if let (Some(x), Some(y)) = (code(a), code(b)) {
        return x == y;
    }
    if norm(&a.title) != norm(&b.title)
        || norm(&a.artist) != norm(&b.artist)
        || norm(&a.artist).is_empty()
    {
        return false;
    }
    matches!((a.duration, b.duration), (Some(x), Some(y)) if x > 0 && y > 0 && x.abs_diff(y) <= 3)
}
pub fn deduplicate(tracks: Vec<Track>) -> Vec<Track> {
    let mut output: Vec<Track> = Vec::new();
    for mut track in tracks {
        if let Some(existing) = output.iter_mut().find(|t| same_recording(t, &track)) {
            for source in track.sources.drain(..) {
                if !existing.sources.iter().any(|s| {
                    s.id == source.id
                        || (!s.url.is_empty()
                            && s.url == source.url
                            && s.provider == source.provider)
                        || (s.local_path.is_some() && s.local_path == source.local_path)
                }) {
                    existing.sources.push(source);
                }
            }
            for id in track.provider_track_ids {
                if !existing.provider_track_ids.contains(&id) {
                    existing.provider_track_ids.push(id);
                }
            }
            if existing.artwork.is_none() {
                existing.artwork = track.artwork;
            }
        } else {
            output.push(track);
        }
    }
    output
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "windows")]
    #[test]
    fn audio_and_video_transports_are_both_retained() {
        let mut a =
            crate::providers::youtube::track("video", "a18py61_F_w", "Song", "Artist", None, None);
        let mut b = a.clone();
        a.sources.retain(|s| s.provider == "youtube");
        b.sources.retain(|s| s.provider == "youtube_audio");
        let merged = deduplicate(vec![a, b]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].sources.len(), 2);
    }
    fn track(id: &str, title: &str, duration: u32, isrc: Option<&str>) -> Track {
        Track {
            id: id.into(),
            title: title.into(),
            artist: "Artist".into(),
            duration: Some(duration),
            isrc: isrc.map(String::from),
            ..Default::default()
        }
    }
    #[test]
    fn duration_boundary_merges() {
        assert_eq!(
            deduplicate(vec![
                track("a", "Song", 199, None),
                track("b", "Song", 201, None)
            ])
            .len(),
            1
        );
    }
    #[test]
    fn versions_and_distinct_isrc_stay_separate() {
        assert_eq!(
            deduplicate(vec![
                track("a", "Song", 200, None),
                track("b", "Song (Live)", 200, None)
            ])
            .len(),
            2
        );
        assert_eq!(
            deduplicate(vec![
                track("a", "Song", 200, Some("A")),
                track("b", "Song", 200, Some("B"))
            ])
            .len(),
            2
        );
    }
    #[test]
    fn matching_isrc_merges() {
        assert_eq!(
            deduplicate(vec![
                track("a", "Song", 200, Some("ab12")),
                track("b", "Song - Single", 202, Some("AB12"))
            ])
            .len(),
            1
        );
    }
    #[test]
    fn unknown_duration_is_not_a_match() {
        assert_eq!(
            deduplicate(vec![
                track("a", "Song", 0, None),
                track("b", "Song", 0, None)
            ])
            .len(),
            2
        );
    }
    #[test]
    fn local_files_with_empty_remote_urls_stay_separate() {
        let mut a = track("a", "First", 100, None);
        let mut b = track("b", "Second", 100, None);
        let mut x =
            crate::models::StreamSource::remote("a".into(), "local", "Local", String::new());
        x.local_path = Some("first.wav".into());
        let mut y = x.clone();
        y.id = "b".into();
        y.local_path = Some("second.wav".into());
        a.sources.push(x);
        b.sources.push(y);
        assert_eq!(deduplicate(vec![a, b]).len(), 2);
    }
}

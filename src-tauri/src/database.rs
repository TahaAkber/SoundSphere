use crate::models::{Library, Track};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub struct Database(pub Mutex<Connection>);
impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS library (id INTEGER PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS catalog (id TEXT PRIMARY KEY, json TEXT NOT NULL);").map_err(|e| e.to_string())?;
        Ok(Self(Mutex::new(conn)))
    }
    pub fn library(&self) -> Result<Library, String> {
        let c = self.0.lock().map_err(|e| e.to_string())?;
        let json: Option<String> = c
            .query_row("SELECT json FROM library WHERE id=1", [], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        json.map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
            .unwrap_or_else(|| Ok(Library::default()))
    }
    pub fn update(
        &self,
        change: impl FnOnce(&mut Library) -> Result<(), String>,
    ) -> Result<Library, String> {
        let c = self.0.lock().map_err(|e| e.to_string())?;
        let json: Option<String> = c
            .query_row("SELECT json FROM library WHERE id=1", [], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        let mut lib = match json {
            Some(s) => serde_json::from_str(&s).map_err(|e| e.to_string())?,
            None => Library::default(),
        };
        change(&mut lib)?;
        let json = serde_json::to_string(&lib).map_err(|e| e.to_string())?;
        c.execute("INSERT INTO library(id,json) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET json=excluded.json", [json]).map_err(|e| e.to_string())?;
        Ok(lib)
    }
    pub fn remember(&self, tracks: &[Track]) -> Result<(), String> {
        let c = self.0.lock().map_err(|e| e.to_string())?;
        for t in tracks {
            c.execute("INSERT INTO catalog(id,json) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET json=excluded.json", params![t.id, serde_json::to_string(t).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub fn track(&self, id: &str) -> Result<Track, String> {
        let c = self.0.lock().map_err(|e| e.to_string())?;
        let json: String = c
            .query_row("SELECT json FROM catalog WHERE id=?1", [id], |r| r.get(0))
            .map_err(|_| "Track not found. Search again or import it first.".to_string())?;
        let mut track: Track = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        drop(c);
        if let Some(saved) = self.library()?.tracks.into_iter().find(|t| t.id == id) {
            for source in saved.sources {
                if !track.sources.iter().any(|s| s.id == source.id) {
                    track.sources.push(source);
                }
            }
        }
        Ok(track)
    }
    pub fn cached(&self, key: &str) -> Option<serde_json::Value> {
        let c = self.0.lock().ok()?;
        let json: String = c
            .query_row(
                "SELECT json FROM cache WHERE key=?1 AND expires>?2",
                params![key, now()],
                |r| r.get(0),
            )
            .ok()?;
        serde_json::from_str(&json).ok()
    }
    pub fn cache(&self, key: &str, value: &impl serde::Serialize, ttl: u64) -> Result<(), String> {
        let c = self.0.lock().map_err(|e| e.to_string())?;
        c.execute("DELETE FROM cache WHERE expires<?1", [now()])
            .map_err(|e| e.to_string())?;
        c.execute("INSERT INTO cache(key,json,expires) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET json=excluded.json,expires=excluded.expires", params![key, serde_json::to_string(value).map_err(|e| e.to_string())?, now()+ttl]).map_err(|e| e.to_string())?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fresh_metadata_preserves_saved_offline_source() {
        let db = Database::open(Path::new(":memory:")).unwrap();
        let remote = Track {
            id: "one".into(),
            title: "Recording".into(),
            ..Default::default()
        };
        let mut saved = remote.clone();
        let mut source = crate::models::StreamSource::remote(
            "offline".into(),
            "local",
            "Offline",
            String::new(),
        );
        source.local_path = Some("audio.mp3".into());
        saved.sources.push(source);
        db.update(|l| {
            l.tracks.push(saved);
            Ok(())
        })
        .unwrap();
        db.remember(&[remote]).unwrap();
        assert_eq!(db.track("one").unwrap().sources[0].id, "offline");
    }
    #[test]
    fn persistence_and_cache() {
        let p =
            std::env::temp_dir().join(format!("soundsphere-test-{}.sqlite", std::process::id()));
        {
            let db = Database::open(&p).unwrap();
            db.update(|l| {
                l.favorites.push("one".into());
                Ok(())
            })
            .unwrap();
            db.cache("query", &vec!["track"], 8).unwrap();
            assert!(db.cached("query").is_some());
        }
        {
            let db = Database::open(&p).unwrap();
            assert_eq!(db.library().unwrap().favorites, vec!["one"]);
        }
        let _ = std::fs::remove_file(p);
    }
}

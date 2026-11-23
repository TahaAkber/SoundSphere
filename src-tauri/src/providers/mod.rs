pub mod archive;
pub mod audius;
pub mod jamendo;
pub mod musify;
pub mod quran;
pub mod youtube;
pub mod youtube_audio;

use reqwest::Client;
use serde_json::Value;
use std::time::Duration;

pub fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent("SoundSphere/0.1 (personal audio player)")
        .connect_timeout(Duration::from_secs(6))
        .timeout(Duration::from_secs(18))
        .build()
        .map_err(|e| e.to_string())
}
pub async fn json(client: &Client, url: &str) -> Result<Value, String> {
    client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}
pub fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(text).collect::<Vec<_>>().join(", "),
        _ => String::new(),
    }
}
pub fn duration(v: &Value) -> Option<u32> {
    v.as_u64().map(|n| n as u32).or_else(|| {
        v.as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .map(|n| n as u32)
    })
}

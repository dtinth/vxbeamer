//! Backend URL and tokens, kept in `$XDG_CONFIG_HOME/vxbeamer/linux.json`
//! (mode 0600) — the same three values the web app keeps in `localStorage`.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::urls;

/// Refresh when the access token has less than this left.
const EXPIRY_BUFFER_SECONDS: u64 = 5 * 60;

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub backend_url: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    /// Overrides the recorder, e.g. `["parecord", "--device=my-mic", ...]`.
    /// It must write raw 16 kHz mono signed 16-bit little-endian PCM to stdout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_command: Option<Vec<String>>,
    /// An ASR configuration id from `/asr/configurations`; the backend's
    /// default when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration: Option<String>,
}

pub fn config_dir() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_else(|| ".".into())).join(".config")
        })
        .join("vxbeamer")
}

pub fn config_path() -> PathBuf {
    config_dir().join("linux.json")
}

impl Config {
    pub fn load() -> Result<Config, String> {
        let path = config_path();
        let text = fs::read_to_string(&path).map_err(|_| {
            format!(
                "Not paired yet ({} not found). Run: vxbeamer-linux pair <link from your backend's /pair page>",
                path.display()
            )
        })?;
        serde_json::from_str(&text).map_err(|e| format!("Could not read {}: {e}", path.display()))
    }

    pub fn save(&self) -> Result<(), String> {
        let path = config_path();
        fs::create_dir_all(config_dir()).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
        // `mode` only applies on creation; tighten a pre-existing file too.
        let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }

    pub fn save_tokens(&mut self, tokens: Tokens) -> Result<(), String> {
        self.access_token = tokens.access_token;
        if let Some(refresh) = tokens.refresh_token {
            self.refresh_token = refresh;
        }
        self.save()
    }

    /// The access token to use now, refreshing (and saving) it first if it is
    /// close to expiring.
    pub fn current_access_token(&mut self) -> Result<String, String> {
        if self.refresh_token.is_empty() {
            return Err("Not signed in. Run: vxbeamer-linux pair <link>".into());
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        match token_expiry(&self.access_token) {
            Some(exp) if exp > now + EXPIRY_BUFFER_SECONDS => {}
            _ => {
                let url = urls::endpoint(&self.backend_url, "/auth/refresh")
                    .ok_or("Invalid backend URL in config")?;
                let tokens = post_json(
                    &url,
                    serde_json::json!({ "refresh_token": self.refresh_token }),
                )
                .map_err(|e| {
                    format!(
                        "Could not refresh the session ({e}). Pair again if this keeps happening."
                    )
                })?;
                self.save_tokens(tokens)?;
            }
        }
        Ok(self.access_token.clone())
    }
}

#[derive(Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
}

/// POSTs JSON and reads back tokens, failing with the backend's own `error` text.
pub fn post_json(url: &str, body: serde_json::Value) -> Result<Tokens, String> {
    match ureq::post(url).send_json(body) {
        Ok(response) => response.into_json::<Tokens>().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, response)) => {
            let reason = response
                .into_json::<serde_json::Value>()
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from));
            Err(reason.unwrap_or_else(|| format!("HTTP {code}")))
        }
        Err(e) => Err(describe_http_error(&e)),
    }
}

/// An HTTP error without its URL, which can carry the access token.
pub fn describe_http_error(error: &ureq::Error) -> String {
    match error {
        ureq::Error::Status(code, _) => format!("HTTP {code}"),
        ureq::Error::Transport(transport) => match transport.message() {
            Some(message) => format!("{} ({message})", transport.kind()),
            None => transport.kind().to_string(),
        },
    }
}

/// The `exp` claim of a JWT, without verifying it (the backend does that).
pub fn token_expiry(token: &str) -> Option<u64> {
    let mut parts = token.split('.');
    let (_, payload, _) = (parts.next()?, parts.next()?, parts.next()?);
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()?
        .get("exp")?
        .as_u64()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_expiry_claim() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"sub":"x","exp":1700000000}"#);
        assert_eq!(token_expiry(&format!("h.{payload}.s")), Some(1_700_000_000));
        assert_eq!(token_expiry("not-a-jwt"), None);
    }
}

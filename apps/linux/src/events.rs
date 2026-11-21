//! Reads the backend's `/sse` stream, mirroring `TranscriptEvents.kt` and
//! `applySSEEvent` in `apps/website/src/store.ts`.
//!
//! **The `referenceId` filter is the whole point.** `/sse` carries every
//! message on the account — other devices, earlier recordings — so a session
//! must pick out its own and ignore the rest.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranscriptUpdate {
    /// Transcription in progress; the text so far.
    Partial(String),
    /// The finished transcript.
    Final(String),
    /// The backend gave up on this recording.
    Failed(String),
}

fn text(message: &Value, key: &str) -> String {
    message
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// What one `/sse` event's `data` means for the recording tagged `reference_id`.
pub fn parse(json: &str, reference_id: &str) -> Option<TranscriptUpdate> {
    let event: Value = serde_json::from_str(json).ok()?;
    let is_ours = |m: &&Value| m.get("referenceId").and_then(Value::as_str) == Some(reference_id);
    let message = match event.get("type").and_then(Value::as_str)? {
        "created" | "updated" => event.get("message").filter(is_ours)?,
        "snapshot" => event
            .get("messages")?
            .as_array()?
            .iter()
            .rev()
            .find(is_ours)?,
        _ => return None,
    };

    // `final` before `status`: the final text can arrive slightly ahead of
    // the event that flips `status` to "done".
    let final_text = text(message, "final");
    if !final_text.is_empty() {
        return Some(TranscriptUpdate::Final(final_text));
    }
    if text(message, "status") == "error" {
        let error = text(message, "error");
        return Some(TranscriptUpdate::Failed(if error.is_empty() {
            "Transcription failed".into()
        } else {
            error
        }));
    }
    let partial = text(message, "partial");
    (!partial.is_empty()).then_some(TranscriptUpdate::Partial(partial))
}

/// Accumulates `data:` lines of a `text/event-stream` into whole events.
#[derive(Default)]
pub struct SseDecoder {
    data: Vec<String>,
}

impl SseDecoder {
    /// Feeds one line (without its newline). Returns an event's data once a
    /// blank line ends it.
    pub fn push_line(&mut self, line: &str) -> Option<String> {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            if self.data.is_empty() {
                return None;
            }
            return Some(std::mem::take(&mut self.data).join("\n"));
        }
        if let Some(rest) = line.strip_prefix("data:") {
            self.data
                .push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
        }
        // Comments (`: keepalive`), `event:`, `id:` and `retry:` carry nothing we use.
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_other_recordings() {
        let json = r#"{"type":"updated","message":{"referenceId":"other","final":"nope"}}"#;
        assert_eq!(parse(json, "mine"), None);
    }

    #[test]
    fn reads_partial_then_final() {
        let partial = r#"{"type":"updated","message":{"referenceId":"mine","partial":"hel"}}"#;
        let done = r#"{"type":"updated","message":{"referenceId":"mine","partial":"x","final":"hello","status":"recording"}}"#;
        assert_eq!(
            parse(partial, "mine"),
            Some(TranscriptUpdate::Partial("hel".into()))
        );
        assert_eq!(
            parse(done, "mine"),
            Some(TranscriptUpdate::Final("hello".into()))
        );
    }

    #[test]
    fn reports_errors() {
        let json = r#"{"type":"updated","message":{"referenceId":"mine","status":"error","error":"boom"}}"#;
        assert_eq!(
            parse(json, "mine"),
            Some(TranscriptUpdate::Failed("boom".into()))
        );
    }

    #[test]
    fn picks_our_message_out_of_a_snapshot() {
        let json = r#"{"type":"snapshot","messages":[{"referenceId":"mine","final":"old"},{"referenceId":"x","final":"y"}]}"#;
        assert_eq!(
            parse(json, "mine"),
            Some(TranscriptUpdate::Final("old".into()))
        );
        assert_eq!(parse(r#"{"type":"snapshot","messages":[]}"#, "mine"), None);
    }

    #[test]
    fn decodes_event_stream_lines() {
        let mut decoder = SseDecoder::default();
        assert_eq!(decoder.push_line(": keepalive"), None);
        assert_eq!(decoder.push_line(""), None);
        assert_eq!(decoder.push_line("data: {\"a\":1}\r"), None);
        assert_eq!(decoder.push_line(""), Some("{\"a\":1}".into()));
    }
}

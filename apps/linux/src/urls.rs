//! The backend's own URLs, mirroring `buildBackendSocketUrl` in
//! `apps/website/src/backendSocket.ts` and `BackendUrls.kt` on Android: the
//! path is replaced (not appended to) and the query is set fresh.

/// Percent-encodes a query value (RFC 3986 unreserved characters pass through).
pub fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// `scheme://host[:port]` of a backend URL, with any path, query or fragment dropped.
pub fn origin(backend_url: &str) -> Option<String> {
    let (scheme, rest) = backend_url.trim().split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{authority}"))
}

fn with_query(base: String, path: &str, params: &[(&str, &str)]) -> String {
    let query: Vec<String> = params
        .iter()
        .map(|(key, value)| format!("{key}={}", encode(value)))
        .collect();
    format!("{base}{path}?{}", query.join("&"))
}

/// `/ws`, with the scheme swapped to `ws`/`wss` — tungstenite, unlike
/// OkHttp, wants the WebSocket scheme spelled out.
pub fn web_socket(
    backend_url: &str,
    access_token: &str,
    reference_id: &str,
    client_id: &str,
    configuration: Option<&str>,
) -> Option<String> {
    let origin = origin(backend_url)?;
    let base = match origin.split_once("://") {
        Some(("https", rest)) => format!("wss://{rest}"),
        Some((_, rest)) => format!("ws://{rest}"),
        None => return None,
    };
    let mut params = vec![
        ("access_token", access_token),
        ("reference_id", reference_id),
        ("client_id", client_id),
    ];
    if let Some(configuration) = configuration.filter(|c| !c.is_empty()) {
        params.push(("configuration", configuration));
    }
    Some(with_query(base, "/ws", &params))
}

pub fn server_sent_events(backend_url: &str, access_token: &str) -> Option<String> {
    Some(with_query(
        origin(backend_url)?,
        "/sse",
        &[("access_token", access_token)],
    ))
}

pub fn endpoint(backend_url: &str, path: &str) -> Option<String> {
    Some(format!("{}{path}", origin(backend_url)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swaps_https_for_wss_and_replaces_the_path() {
        assert_eq!(
            web_socket(
                "https://vx.example.com/some/path?x=1",
                "a.b-c",
                "ref#1",
                "cid",
                None
            )
            .unwrap(),
            "wss://vx.example.com/ws?access_token=a.b-c&reference_id=ref%231&client_id=cid"
        );
    }

    #[test]
    fn keeps_the_port_and_uses_ws_for_http() {
        assert_eq!(
            web_socket("http://localhost:8787", "t", "r", "c", Some("mock/mock")).unwrap(),
            "ws://localhost:8787/ws?access_token=t&reference_id=r&client_id=c&configuration=mock%2Fmock"
        );
    }

    #[test]
    fn builds_the_event_stream_url() {
        assert_eq!(
            server_sent_events("https://vx.example.com/", "t").unwrap(),
            "https://vx.example.com/sse?access_token=t"
        );
    }

    #[test]
    fn rejects_non_http_urls() {
        assert_eq!(origin("ftp://example.com"), None);
        assert_eq!(origin("example.com"), None);
    }
}

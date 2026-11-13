//! Signing in with a link from the backend's `/pair` page. The link is
//! `<backend>/pair#<code>`, so it names the backend as well as the code.
//! Mirrors `apps/website/src/pairing.ts` and `Pairing.kt`.

use crate::urls;

#[derive(Debug, PartialEq, Eq)]
pub struct Link {
    pub backend_url: String,
    pub code: String,
}

const CODE_ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn is_code(code: &str) -> bool {
    code.len() == 12 && code.chars().all(|c| CODE_ALPHABET.contains(c))
}

/// Reads a pairing link as pasted. `None` when it is not one.
pub fn parse_link(input: &str) -> Option<Link> {
    let input = input.trim();
    let (without_fragment, fragment) = input.split_once('#')?;
    let origin = urls::origin(without_fragment)?;
    let (scheme, authority) = origin.split_once("://")?;
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, h)| h)
        .split(':')
        .next()
        .unwrap_or("");
    let is_local = host == "localhost" || host == "127.0.0.1";
    if scheme != "https" && !is_local {
        return None;
    }
    let path = without_fragment[without_fragment.find("://")? + 3..]
        .split(['?'])
        .next()
        .unwrap_or("");
    let path = path.find('/').map_or("", |i| &path[i..]);
    if path.trim_end_matches('/') != "/pair" {
        return None;
    }
    let code: String = fragment
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect::<String>()
        .to_ascii_uppercase();
    if !is_code(&code) {
        return None;
    }
    Some(Link {
        backend_url: origin,
        code,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_pairing_link() {
        assert_eq!(
            parse_link(" https://vx.example.com/pair#abcd-efgh-jkmn \n"),
            Some(Link {
                backend_url: "https://vx.example.com".into(),
                code: "ABCDEFGHJKMN".into()
            })
        );
    }

    #[test]
    fn allows_plain_http_only_on_localhost() {
        assert!(parse_link("http://localhost:8787/pair#ABCDEFGHJKMN").is_some());
        assert!(parse_link("http://vx.example.com/pair#ABCDEFGHJKMN").is_none());
    }

    #[test]
    fn rejects_other_paths_and_bad_codes() {
        assert!(parse_link("https://vx.example.com/other#ABCDEFGHJKMN").is_none());
        assert!(parse_link("https://vx.example.com/pair#ABCDEFGHJKMI").is_none());
        assert!(parse_link("https://vx.example.com/pair#SHORT").is_none());
        assert!(parse_link("https://vx.example.com/pair").is_none());
    }
}

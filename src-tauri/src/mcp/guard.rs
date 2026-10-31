//! Who may talk to the MCP server: a local process that knows the token.
//!
//! - `Host` must name the loopback interface (localhost, 127.0.0.1, [::1]):
//!   a web page that rebinds its own DNS name to 127.0.0.1 still sends its
//!   own name here.
//! - Any `Origin` header is refused: MCP clients are processes, not web pages,
//!   and browsers always attach `Origin` to cross-site POSTs.
//! - `Authorization: Bearer <token>` must match the token in the app config
//!   dir (`mcp-token`), compared in constant time.

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::sync::{Arc, RwLock};

#[derive(Debug, PartialEq, Eq)]
pub enum Reject {
    /// 403: an `Origin` header (a browser).
    Origin,
    /// 403: `Host` missing or not loopback.
    Host,
    /// 401: no or wrong bearer token.
    Token,
}

impl Reject {
    fn status(&self) -> StatusCode {
        match self {
            Reject::Origin | Reject::Host => StatusCode::FORBIDDEN,
            Reject::Token => StatusCode::UNAUTHORIZED,
        }
    }
    fn message(&self) -> &'static str {
        match self {
            Reject::Origin => "VPuppet MCP: requests from web pages (with an Origin header) are not accepted",
            Reject::Host => "VPuppet MCP: Host must be localhost or 127.0.0.1",
            Reject::Token => "VPuppet MCP: missing or wrong bearer token (see the mcp-token file in VPuppet's config folder)",
        }
    }
}

/// True for `localhost`, `127.0.0.1` and `[::1]`, with or without a port.
pub fn is_loopback_host(host: &str) -> bool {
    let h = host.trim();
    let name = if let Some(rest) = h.strip_prefix('[') {
        // [::1]:port
        match rest.split_once(']') {
            Some((inner, tail)) if tail.is_empty() || tail.starts_with(':') => inner,
            _ => return false,
        }
    } else {
        match h.rsplit_once(':') {
            Some((n, port)) if !n.contains(':') && port.chars().all(|c| c.is_ascii_digit()) => n,
            Some(_) => return false,
            None => h,
        }
    };
    name.eq_ignore_ascii_case("localhost") || name == "127.0.0.1" || name == "::1"
}

/// Constant-time equality (length leaks, which is fixed for our tokens).
pub fn same(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn bearer(v: &HeaderValue) -> Option<&str> {
    let s = v.to_str().ok()?.trim();
    let (scheme, tok) = s.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| tok.trim())
}

/// The whole check, in order: browser, host, token.
pub fn check(headers: &HeaderMap, token: &str) -> Result<(), Reject> {
    if headers.contains_key(header::ORIGIN) {
        return Err(Reject::Origin);
    }
    match headers.get(header::HOST).and_then(|h| h.to_str().ok()) {
        Some(h) if is_loopback_host(h) => {}
        _ => return Err(Reject::Host),
    }
    let ok = !token.is_empty()
        && headers.get(header::AUTHORIZATION).and_then(bearer).is_some_and(|t| same(t.as_bytes(), token.as_bytes()));
    if ok {
        Ok(())
    } else {
        Err(Reject::Token)
    }
}

/// The token shared with the middleware (replaced in place when reset).
pub type SharedToken = Arc<RwLock<String>>;

/// axum middleware around the MCP service.
pub async fn middleware(State(token): State<SharedToken>, req: Request, next: Next) -> Response {
    let verdict = {
        let t = token.read().unwrap_or_else(|e| e.into_inner());
        check(req.headers(), &t)
    };
    match verdict {
        Ok(()) => next.run(req).await,
        Err(r) => {
            let mut res = (r.status(), r.message()).into_response();
            if r == Reject::Token {
                res.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer realm=\"vpuppet\""));
            }
            res
        }
    }
}

/// 32 random bytes as 64 hex characters.
pub fn new_token() -> Result<String, String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| format!("random: {e}"))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    const T: &str = "abc123";

    #[test]
    fn loopback_hosts() {
        for ok in ["localhost", "LOCALHOST:39540", "127.0.0.1", "127.0.0.1:39540", "[::1]", "[::1]:39540"] {
            assert!(is_loopback_host(ok), "{ok}");
        }
        for bad in ["evil.com", "evil.com:39540", "127.0.0.1.evil.com", "localhost.evil.com:80", "0.0.0.0:39540", "[::1]x", "::1", "192.168.1.2:39540", "127.0.0.1:x", ""] {
            assert!(!is_loopback_host(bad), "{bad}");
        }
    }

    #[test]
    fn accepts_a_local_client_with_the_token() {
        let h = headers(&[("host", "127.0.0.1:39540"), ("authorization", "Bearer abc123")]);
        assert_eq!(check(&h, T), Ok(()));
        let h = headers(&[("host", "localhost:39540"), ("authorization", "bearer   abc123 ")]);
        assert_eq!(check(&h, T), Ok(()));
    }

    #[test]
    fn rejects_browsers_even_with_the_token() {
        let h = headers(&[("host", "127.0.0.1:39540"), ("authorization", "Bearer abc123"), ("origin", "http://localhost:5173")]);
        assert_eq!(check(&h, T), Err(Reject::Origin));
        let h = headers(&[("host", "127.0.0.1:39540"), ("authorization", "Bearer abc123"), ("origin", "null")]);
        assert_eq!(check(&h, T), Err(Reject::Origin));
    }

    #[test]
    fn rejects_rebound_hosts() {
        let h = headers(&[("host", "attacker.example:39540"), ("authorization", "Bearer abc123")]);
        assert_eq!(check(&h, T), Err(Reject::Host));
        let h = headers(&[("authorization", "Bearer abc123")]);
        assert_eq!(check(&h, T), Err(Reject::Host));
    }

    #[test]
    fn rejects_missing_or_wrong_tokens() {
        let base = ("host", "127.0.0.1:39540");
        assert_eq!(check(&headers(&[base]), T), Err(Reject::Token));
        assert_eq!(check(&headers(&[base, ("authorization", "Bearer abc124")]), T), Err(Reject::Token));
        assert_eq!(check(&headers(&[base, ("authorization", "Bearer abc1234")]), T), Err(Reject::Token));
        assert_eq!(check(&headers(&[base, ("authorization", "Basic abc123")]), T), Err(Reject::Token));
        assert_eq!(check(&headers(&[base, ("authorization", "abc123")]), T), Err(Reject::Token));
        // An empty token never matches (e.g. an unreadable token file).
        assert_eq!(check(&headers(&[base, ("authorization", "Bearer ")]), ""), Err(Reject::Token));
    }

    #[test]
    fn tokens_are_random_hex() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}

//! The call that gets a fork's streams made. A Felix client cannot create a
//! stream, only the control plane can, and the sim holds no credential for it.
//! The deployment runs a provisioner that does, and the sim asks it over plain
//! HTTP on the deployment's own network.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::Request;

/// How long the provisioner gets to answer. Making streams takes a few seconds
/// while the brokers elect leaders.
const TIMEOUT: Duration = Duration::from_secs(60);

/// Asks the provisioner at `base` (`http://host:port`) to make the streams of
/// `request`'s fork and give it its access, and returns once it has. The call
/// can be repeated: a stream that exists is kept.
///
/// ```text
/// POST /forks   {"city":"harbor~bridge","parent":"harbor","shards":4}
/// ```
pub(crate) async fn create_streams(base: &str, request: &Request) -> Result<()> {
    let body = format!(
        "{{\"city\":\"{}\",\"parent\":\"{}\",\"shards\":{}}}",
        request.child,
        request.parent,
        request.districts()
    );
    let (status, text) = tokio::time::timeout(TIMEOUT, post(base, "/forks", &body))
        .await
        .context("the provisioner did not answer in time")??;
    if !(200..300).contains(&status) {
        bail!("the provisioner answered {status}: {}", text.trim());
    }
    Ok(())
}

/// A request with a JSON `body`: the status and the text of the answer.
async fn post(base: &str, route: &str, body: &str) -> Result<(u16, String)> {
    let rest = base.strip_prefix("http://").with_context(|| {
        format!("{base:?}: the provisioner must be an http:// address on the deployment's network")
    })?;
    let (host, prefix) = rest.split_once('/').unwrap_or((rest, ""));
    let path = format!("/{}{route}", prefix.trim_matches('/'));
    let path = path.replacen("//", "/", 1);
    let mut stream = TcpStream::connect(host)
        .await
        .with_context(|| format!("connect to the provisioner at {host}"))?;
    let request = format!(
        "POST {path} HTTP/1.1\r\nhost: {host}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await?;
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).await?;
    let answer = String::from_utf8_lossy(&answer);
    let (head, text) = answer.split_once("\r\n\r\n").unwrap_or((&answer, ""));
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .with_context(|| format!("the provisioner sent no status: {head:?}"))?;
    Ok((status, text.to_owned()))
}

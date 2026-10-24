//! The operator's way to change a city's speed: a small HTTP endpoint on the
//! loopback interface. The builders' `speed` command replaces it once commands
//! reach the sim.

use std::collections::HashMap;
use std::net::SocketAddr;

use anyhow::{Result, bail};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tracing::{info, warn};

/// The speeds a city may run at, in ticks per second; 0 is paused.
pub const SPEEDS: [u8; 4] = [0, 4, 8, 16];

/// `ticks_per_second` if it is one of [`SPEEDS`].
pub fn check_speed(ticks_per_second: u8) -> Result<u8> {
    if !SPEEDS.contains(&ticks_per_second) {
        bail!("speed {ticks_per_second} is not one of 0, 4, 8 or 16");
    }
    Ok(ticks_per_second)
}

/// Serves `PUT /cities/<name>/speed` (body: 0, 4, 8 or 16) and
/// `GET /cities/<name>/speed` on `listener`, which must be bound to a loopback
/// address because the endpoint has no authentication.
pub async fn serve(
    listener: TcpListener,
    cities: HashMap<String, watch::Sender<u8>>,
) -> Result<()> {
    if !listener.local_addr()?.ip().is_loopback() {
        bail!("the speed endpoint has no authentication and must bind to a loopback address");
    }
    let cities = std::sync::Arc::new(cities);
    loop {
        let (stream, peer) = listener.accept().await?;
        let cities = std::sync::Arc::clone(&cities);
        tokio::spawn(async move {
            if let Err(err) = handle(stream, peer, &cities).await {
                warn!(%peer, error = %format!("{err:#}"), "speed request failed");
            }
        });
    }
}

async fn handle(
    mut stream: TcpStream,
    peer: SocketAddr,
    cities: &HashMap<String, watch::Sender<u8>>,
) -> Result<()> {
    // A speed request is a few dozen bytes.
    let mut buf = vec![0u8; 2048];
    let mut len = 0;
    let head_end = loop {
        if let Some(i) = buf[..len].windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if len == buf.len() {
            bail!("request too large");
        }
        let n = stream.read(&mut buf[len..]).await?;
        if n == 0 {
            bail!("closed before the request ended");
        }
        len += n;
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let content_length = head
        .lines()
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    if head_end + content_length > buf.len() {
        bail!("request too large");
    }
    while len < head_end + content_length {
        let n = stream.read(&mut buf[len..]).await?;
        if n == 0 {
            bail!("closed before the body ended");
        }
        len += n;
    }
    let body = String::from_utf8_lossy(&buf[head_end..head_end + content_length]).into_owned();
    let mut first = head.lines().next().unwrap_or("").split_whitespace();
    let (method, path) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let (status, text) = respond(method, path, &body, cities, peer);
    let reply = format!(
        "HTTP/1.1 {status}\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
        text.len()
    );
    stream.write_all(reply.as_bytes()).await?;
    stream.shutdown().await?;
    Ok(())
}

fn respond(
    method: &str,
    path: &str,
    body: &str,
    cities: &HashMap<String, watch::Sender<u8>>,
    peer: SocketAddr,
) -> (&'static str, String) {
    let city = path
        .strip_prefix("/cities/")
        .and_then(|p| p.strip_suffix("/speed"));
    let Some(sender) = city.and_then(|c| cities.get(c)) else {
        return ("404 Not Found", "no such city\n".into());
    };
    match method {
        "GET" => ("200 OK", format!("{}\n", *sender.borrow())),
        "PUT" | "POST" => match body.trim().parse().ok().map(check_speed) {
            Some(Ok(speed)) => {
                info!(%peer, city = city.unwrap_or(""), speed, "speed set");
                sender.send_replace(speed);
                ("200 OK", format!("{speed}\n"))
            }
            _ => ("400 Bad Request", "the body must be 0, 4, 8 or 16\n".into()),
        },
        _ => ("405 Method Not Allowed", "use GET or PUT\n".into()),
    }
}

#[cfg(test)]
mod tests;

//! The operator's way to change a city's speed: a small HTTP endpoint on the
//! loopback interface. The builders' `speed` command replaces it once commands
//! reach the sim.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, bail};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, watch};
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
/// address because the endpoint has no authentication. `POST
/// /cities/<name>/start` starts a city in `starts`, one that was held back, and
/// answers once its streams are open, or with a 500 when they would not open.
/// `GET /cities/<name>/warmup` answers `warming` until the city has committed
/// its warm-up and `live` after, so a script can wait for a city to go live.
pub async fn serve(
    listener: TcpListener,
    cities: HashMap<String, watch::Sender<u8>>,
    starts: HashMap<String, mpsc::Sender<StartRequest>>,
    warming: HashMap<String, watch::Receiver<bool>>,
) -> Result<()> {
    if !listener.local_addr()?.ip().is_loopback() {
        bail!("the speed endpoint has no authentication and must bind to a loopback address");
    }
    let cities = Arc::new(Cities {
        speeds: cities,
        starts,
        warming,
    });
    loop {
        let (stream, peer) = listener.accept().await?;
        let cities = Arc::clone(&cities);
        tokio::spawn(async move {
            if let Err(err) = handle(stream, peer, &cities).await {
                warn!(%peer, error = %format!("{err:#}"), "speed request failed");
            }
        });
    }
}

/// A request to start a held-back city. The city answers `Ok` once it runs, or why it could not
/// start, and then waits for the next request.
pub type StartRequest = oneshot::Sender<Result<(), String>>;

/// What the endpoint can reach.
struct Cities {
    speeds: HashMap<String, watch::Sender<u8>>,
    starts: HashMap<String, mpsc::Sender<StartRequest>>,
    warming: HashMap<String, watch::Receiver<bool>>,
}

/// How long a start request waits for the city's streams to open.
const START_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a client gets to send its request.
const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// A speed request is a few dozen bytes.
const MAX_REQUEST: usize = 2048;

/// A request turned away before it reached a city.
struct Reject(&'static str, &'static str);

async fn handle(mut stream: TcpStream, peer: SocketAddr, cities: &Cities) -> Result<()> {
    let port = stream.local_addr()?.port();
    let read = tokio::time::timeout(READ_TIMEOUT, read_request(&mut stream)).await;
    let (status, text) = match read {
        Err(_) => (
            "408 Request Timeout",
            "request not received in time\n".into(),
        ),
        Ok(Err(Reject(status, text))) => (status, format!("{text}\n")),
        Ok(Ok((head, body))) => match check_origin(&head, port) {
            Err(Reject(status, text)) => (status, format!("{text}\n")),
            Ok(()) => {
                let mut first = head.lines().next().unwrap_or("").split_whitespace();
                let (method, path) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
                respond(method, path, &body, cities, peer).await
            }
        },
    };
    let reply = format!(
        "HTTP/1.1 {status}\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
        text.len()
    );
    stream.write_all(reply.as_bytes()).await?;
    stream.shutdown().await?;
    Ok(())
}

async fn read_request(stream: &mut TcpStream) -> Result<(String, String), Reject> {
    let io_err = |_| Reject("400 Bad Request", "could not read the request");
    let mut buf = vec![0u8; MAX_REQUEST];
    let mut len = 0;
    let head_end = loop {
        if let Some(i) = buf[..len].windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if len == buf.len() {
            return Err(Reject("413 Payload Too Large", "request too large"));
        }
        let n = stream.read(&mut buf[len..]).await.map_err(io_err)?;
        if n == 0 {
            return Err(Reject("400 Bad Request", "closed before the request ended"));
        }
        len += n;
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let content_length = header(&head, "content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    // Compared before adding: a huge Content-Length must not overflow.
    if content_length > MAX_REQUEST - head_end {
        return Err(Reject("413 Payload Too Large", "request too large"));
    }
    while len < head_end + content_length {
        let n = stream.read(&mut buf[len..]).await.map_err(io_err)?;
        if n == 0 {
            return Err(Reject("400 Bad Request", "closed before the body ended"));
        }
        len += n;
    }
    let body = String::from_utf8_lossy(&buf[head_end..head_end + content_length]).into_owned();
    Ok((head, body))
}

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines()
        .skip(1)
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case(name))
        .map(|(_, v)| v.trim())
}

/// A browser tab can reach loopback with a cross-origin request or a rebound
/// DNS name. Browsers always send `Origin` on those and never on `curl`, and a
/// rebound name shows up in `Host`.
fn check_origin(head: &str, port: u16) -> Result<(), Reject> {
    if header(head, "origin").is_some() {
        return Err(Reject("403 Forbidden", "cross-origin requests are refused"));
    }
    let host_ok = header(head, "host").is_some_and(|h| {
        let Some((name, p)) = h.rsplit_once(':') else {
            return false;
        };
        p == port.to_string() && matches!(name, "127.0.0.1" | "localhost" | "[::1]")
    });
    if !host_ok {
        return Err(Reject(
            "403 Forbidden",
            "the host must be loopback with the bound port",
        ));
    }
    Ok(())
}

async fn respond(
    method: &str,
    path: &str,
    body: &str,
    cities: &Cities,
    peer: SocketAddr,
) -> (&'static str, String) {
    if let Some(name) = path
        .strip_prefix("/cities/")
        .and_then(|p| p.strip_suffix("/start"))
    {
        let Some(start) = cities.starts.get(name) else {
            return ("404 Not Found", "no such city to start\n".into());
        };
        if !matches!(method, "POST" | "PUT") {
            return ("405 Method Not Allowed", "use POST\n".into());
        }
        info!(%peer, city = name, "start requested");
        let (reply, answer) = oneshot::channel();
        // A city that is running has dropped its requests, and one that started while this waited drops this.
        if start.send(reply).await.is_err() {
            return ("200 OK", "already started\n".into());
        }
        return match tokio::time::timeout(START_TIMEOUT, answer).await {
            Ok(Ok(Ok(()))) => ("200 OK", "started\n".into()),
            Ok(Ok(Err(why))) => ("500 Internal Server Error", format!("{why}\n")),
            Ok(Err(_)) => ("200 OK", "already started\n".into()),
            Err(_) => ("504 Gateway Timeout", "the city is still starting\n".into()),
        };
    }
    if let Some(name) = path
        .strip_prefix("/cities/")
        .and_then(|p| p.strip_suffix("/warmup"))
    {
        let Some(warming) = cities.warming.get(name) else {
            return ("404 Not Found", "no such city\n".into());
        };
        if method != "GET" {
            return ("405 Method Not Allowed", "use GET\n".into());
        }
        let state = if *warming.borrow() { "warming" } else { "live" };
        return ("200 OK", format!("{state}\n"));
    }
    let city = path
        .strip_prefix("/cities/")
        .and_then(|p| p.strip_suffix("/speed"));
    let Some(sender) = city.and_then(|c| cities.speeds.get(c)) else {
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

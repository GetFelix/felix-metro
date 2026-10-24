use std::collections::HashMap;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};

use super::*;

async fn request(addr: SocketAddr, method: &str, path: &str, body: &str) -> String {
    let extra = format!("host: {addr}\r\n");
    raw(addr, method, path, &extra, body).await
}

async fn raw(addr: SocketAddr, method: &str, path: &str, headers: &str, body: &str) -> String {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let req = format!(
        "{method} {path} HTTP/1.1\r\n{headers}content-length: {}\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut out = String::new();
    stream.read_to_string(&mut out).await.unwrap();
    out
}

#[test]
fn only_pause_and_the_three_speeds_pass() {
    for n in 0..=255u8 {
        assert_eq!(check_speed(n).is_ok(), [0, 4, 8, 16].contains(&n), "{n}");
    }
}

#[tokio::test]
async fn put_sets_the_speed_and_bad_requests_change_nothing() {
    let (tx, rx) = watch::channel(4u8);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(serve(
        listener,
        HashMap::from([("harbor".to_owned(), tx)]),
        HashMap::new(),
        HashMap::new(),
    ));

    assert!(
        request(addr, "GET", "/cities/harbor/speed", "")
            .await
            .ends_with("\n4\n")
    );
    assert!(
        request(addr, "PUT", "/cities/harbor/speed", "16")
            .await
            .starts_with("HTTP/1.1 200")
    );
    assert_eq!(*rx.borrow(), 16);
    assert!(
        request(addr, "PUT", "/cities/harbor/speed", "0")
            .await
            .starts_with("HTTP/1.1 200")
    );
    assert_eq!(*rx.borrow(), 0);
    for body in ["5", "256", "fast", ""] {
        let reply = request(addr, "PUT", "/cities/harbor/speed", body).await;
        assert!(reply.starts_with("HTTP/1.1 400"), "{body}: {reply}");
        assert_eq!(*rx.borrow(), 0);
    }
    assert!(
        request(addr, "PUT", "/cities/nowhere/speed", "8")
            .await
            .starts_with("HTTP/1.1 404")
    );
    assert!(
        request(addr, "DELETE", "/cities/harbor/speed", "")
            .await
            .starts_with("HTTP/1.1 405")
    );
}

#[tokio::test]
async fn a_non_loopback_address_is_refused() {
    let listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
    assert!(
        serve(listener, HashMap::new(), HashMap::new(), HashMap::new())
            .await
            .is_err()
    );
}

async fn city_at(speed: u8) -> (SocketAddr, watch::Receiver<u8>) {
    let (tx, rx) = watch::channel(speed);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(serve(
        listener,
        HashMap::from([("harbor".to_owned(), tx)]),
        HashMap::new(),
        HashMap::new(),
    ));
    (addr, rx)
}

#[tokio::test]
async fn a_request_with_an_origin_header_is_refused() {
    let (addr, rx) = city_at(4).await;
    let headers = format!("host: {addr}\r\norigin: http://evil.example\r\n");
    let reply = raw(addr, "PUT", "/cities/harbor/speed", &headers, "16").await;
    assert!(reply.starts_with("HTTP/1.1 403"), "{reply}");
    assert_eq!(*rx.borrow(), 4);
}

#[tokio::test]
async fn a_host_that_is_not_loopback_with_the_bound_port_is_refused() {
    let (addr, rx) = city_at(4).await;
    let port = addr.port();
    for host in [
        "evil.example".to_owned(),
        format!("evil.example:{port}"),
        format!("127.0.0.1:{}", port.wrapping_add(1)),
        "127.0.0.1".to_owned(),
    ] {
        let headers = format!("host: {host}\r\n");
        let reply = raw(addr, "PUT", "/cities/harbor/speed", &headers, "16").await;
        assert!(reply.starts_with("HTTP/1.1 403"), "{host}: {reply}");
    }
    let reply = raw(addr, "PUT", "/cities/harbor/speed", "", "16").await;
    assert!(reply.starts_with("HTTP/1.1 403"), "no host: {reply}");
    assert_eq!(*rx.borrow(), 4);
    for host in [format!("localhost:{port}"), format!("[::1]:{port}")] {
        let headers = format!("host: {host}\r\n");
        let reply = raw(addr, "GET", "/cities/harbor/speed", &headers, "").await;
        assert!(reply.starts_with("HTTP/1.1 200"), "{host}: {reply}");
    }
}

#[tokio::test]
async fn a_huge_content_length_is_refused_without_overflowing() {
    let (addr, rx) = city_at(4).await;
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let req = format!(
        "PUT /cities/harbor/speed HTTP/1.1\r\nhost: {addr}\r\ncontent-length: {}\r\n\r\n",
        usize::MAX
    );
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut out = String::new();
    stream.read_to_string(&mut out).await.unwrap();
    assert!(out.starts_with("HTTP/1.1 413"), "{out}");
    assert_eq!(*rx.borrow(), 4);
}

#[tokio::test(start_paused = true)]
async fn a_client_that_stalls_is_cut_off() {
    let (addr, _rx) = city_at(4).await;
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream
        .write_all(b"PUT /cities/harbor/speed HTT")
        .await
        .unwrap();
    let mut out = String::new();
    tokio::time::timeout(Duration::from_secs(30), stream.read_to_string(&mut out))
        .await
        .expect("the server hung on a stalled client")
        .unwrap();
    assert!(out.starts_with("HTTP/1.1 408"), "{out}");
}

#[tokio::test]
async fn post_starts_a_city_held_back_and_nothing_else() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (requests, mut starting) = mpsc::channel(1);
    let starts = HashMap::from([("lakeside".to_owned(), requests)]);
    tokio::spawn(serve(listener, HashMap::new(), starts, HashMap::new()));

    for (method, path, status) in [
        ("GET", "/cities/lakeside/start", "405"),
        ("POST", "/cities/harbor/start", "404"),
    ] {
        let reply = request(addr, method, path, "").await;
        assert!(reply.starts_with(&format!("HTTP/1.1 {status}")), "{reply}");
    }
    assert!(
        starting.try_recv().is_err(),
        "a refused request started the city"
    );

    let reply =
        tokio::spawn(async move { request(addr, "POST", "/cities/lakeside/start", "").await });
    let answer = tokio::time::timeout(Duration::from_secs(1), starting.recv())
        .await
        .expect("the city was not asked to start")
        .unwrap();
    answer.send(Ok(())).unwrap();
    let reply = reply.await.unwrap();
    assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
}

#[tokio::test]
async fn a_city_that_cannot_start_is_a_500_and_can_be_asked_again() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (requests, mut starting) = mpsc::channel(1);
    let starts = HashMap::from([("lakeside".to_owned(), requests)]);
    tokio::spawn(serve(listener, HashMap::new(), starts, HashMap::new()));

    let first =
        tokio::spawn(async move { request(addr, "POST", "/cities/lakeside/start", "").await });
    starting
        .recv()
        .await
        .unwrap()
        .send(Err("no streams".into()))
        .unwrap();
    let reply = first.await.unwrap();
    assert!(reply.starts_with("HTTP/1.1 500"), "{reply}");
    assert!(reply.contains("no streams"), "{reply}");

    let second =
        tokio::spawn(async move { request(addr, "POST", "/cities/lakeside/start", "").await });
    starting.recv().await.unwrap().send(Ok(())).unwrap();
    assert!(second.await.unwrap().starts_with("HTTP/1.1 200"));
    // Once the city runs nobody listens for requests, and asking again is harmless.
    drop(starting);
    let again = request(addr, "POST", "/cities/lakeside/start", "").await;
    assert!(again.starts_with("HTTP/1.1 200"), "{again}");
}

#[tokio::test]
async fn warmup_says_warming_until_the_city_goes_live() {
    let (tx, rx) = watch::channel(true);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(serve(
        listener,
        HashMap::new(),
        HashMap::new(),
        HashMap::from([("harbor".to_owned(), rx)]),
    ));
    assert!(
        request(addr, "GET", "/cities/harbor/warmup", "")
            .await
            .ends_with("\nwarming\n")
    );
    tx.send_replace(false);
    assert!(
        request(addr, "GET", "/cities/harbor/warmup", "")
            .await
            .ends_with("\nlive\n")
    );
    assert!(
        request(addr, "GET", "/cities/nowhere/warmup", "")
            .await
            .starts_with("HTTP/1.1 404")
    );
}

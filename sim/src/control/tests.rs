use std::collections::HashMap;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use super::*;

async fn request(addr: SocketAddr, method: &str, path: &str, body: &str) -> String {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let req = format!(
        "{method} {path} HTTP/1.1\r\nhost: x\r\ncontent-length: {}\r\n\r\n{body}",
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
    tokio::spawn(serve(listener, HashMap::from([("harbor".to_owned(), tx)])));

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
    assert!(serve(listener, HashMap::new()).await.is_err());
}

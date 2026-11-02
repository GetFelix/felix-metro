use felix_metro_core::record::{REFUSED_FORK_NAME, REFUSED_FORK_TOO_DEEP};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::provision::create_streams;
use super::*;

#[test]
fn a_fork_is_named_after_its_parent() {
    assert_eq!(
        lineage("harbor", "bridge-closed"),
        Ok("harbor~bridge-closed".into())
    );
    assert_eq!(
        lineage("harbor~bridge", "night-shift"),
        Ok("harbor~bridge~night-shift".into())
    );
    for bad in ["", "Bridge", "a b", "a~b", "a_b", "a.b", &"x".repeat(33)] {
        assert_eq!(lineage("harbor", bad), Err(REFUSED_FORK_NAME), "{bad:?}");
    }
    assert_eq!(lineage("harbor", &"x".repeat(32)).map(|n| n.len()), Ok(39));
}

#[test]
fn a_lineage_over_sixty_four_bytes_is_too_deep() {
    let parent = format!("harbor~{}", "a".repeat(32));
    assert_eq!(parent.len(), 39);
    assert_eq!(lineage(&parent, &"b".repeat(24)).map(|n| n.len()), Ok(64));
    assert_eq!(
        lineage(&parent, &"b".repeat(25)),
        Err(REFUSED_FORK_TOO_DEEP)
    );
    // The name is judged first: a bad one is bad however deep the parent is.
    assert_eq!(lineage(&parent, "B"), Err(REFUSED_FORK_NAME));
}

#[test]
fn the_gateway_sees_a_fork_without_its_tilde() {
    assert_eq!(felix_name("harbor"), "harbor");
    assert_eq!(felix_name("harbor~bridge-closed"), "harbor_bridge-closed");
    assert_eq!(felix_name("harbor~a~b"), "harbor_a_b");
    assert_eq!(root_of("harbor~a~b"), "harbor");
    assert_eq!(root_of("harbor"), "harbor");
    assert_eq!(
        crate::felix::events_stream("harbor~bridge"),
        "metro.events.harbor_bridge"
    );
    assert_eq!(
        crate::commands::commands_stream("harbor~bridge"),
        "metro.commands.harbor_bridge"
    );
}

fn request() -> Request {
    Request {
        parent: "harbor".into(),
        child: "harbor~bridge".into(),
        tick: 40,
        principal: 1,
        side: 2,
    }
}

/// A server that answers one request with `status`, and gives back what it was sent.
async fn provisioner(status: &str) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/dev", listener.local_addr().unwrap());
    let status = status.to_owned();
    let seen = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut got = vec![0u8; 4096];
        let mut len = 0;
        // The request is small: read until the body, which ends the JSON object, has arrived.
        while !got[..len].ends_with(b"}") {
            let n = stream.read(&mut got[len..]).await.unwrap();
            assert!(n > 0, "closed before the body");
            len += n;
        }
        let reply =
            format!("HTTP/1.1 {status}\r\ncontent-length: 4\r\nconnection: close\r\n\r\nnope");
        stream.write_all(reply.as_bytes()).await.unwrap();
        String::from_utf8(got[..len].to_vec()).unwrap()
    });
    (base, seen)
}

#[tokio::test]
async fn the_provisioner_is_asked_for_the_forks_streams() {
    let (base, seen) = provisioner("200 OK").await;
    create_streams(&base, &request()).await.unwrap();
    let sent = seen.await.unwrap();
    assert!(sent.starts_with("POST /dev/forks HTTP/1.1\r\n"), "{sent}");
    assert!(
        sent.ends_with(r#"{"city":"harbor~bridge","parent":"harbor","shards":4}"#),
        "{sent}"
    );
}

#[tokio::test]
async fn a_provisioner_that_refuses_is_an_error_with_its_reason() {
    let (base, _seen) = provisioner("500 Internal Server Error").await;
    let err = create_streams(&base, &request()).await.unwrap_err();
    assert!(format!("{err:#}").contains("500"), "{err:#}");
    assert!(format!("{err:#}").contains("nope"), "{err:#}");
    let err = create_streams("https://provisioner", &request())
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("http://"), "{err:#}");
}

fn listed_fork(name: &str) -> felix_metro_core::record::RegistryRecord {
    felix_metro_core::record::RegistryRecord::Forked {
        name: name.into(),
        parent: "harbor".into(),
        tick: 3,
        wall_us: 1,
        principal: 1,
    }
}

#[test]
fn a_fork_listed_twice_starts_one_city() {
    use felix_metro_core::record::RegistryRecord::Created;
    let listed = vec![
        Created {
            name: "lakeside".into(),
            seed: "lakeside".into(),
            districts: 3,
            wall_us: 1,
        },
        listed_fork("harbor~a"),
        listed_fork("harbor~b"),
        listed_fork("harbor~a"),
        listed_fork("lakeside~c"),
        listed_fork("unknown~d"),
        listed_fork("harbor~b"),
    ];
    let sides = std::collections::HashMap::from([("harbor".to_owned(), 2)]);
    assert_eq!(
        make::existing_forks(&listed, &sides),
        [
            ("harbor~a".to_owned(), 2),
            ("harbor~b".to_owned(), 2),
            ("lakeside~c".to_owned(), 3),
        ]
    );
}

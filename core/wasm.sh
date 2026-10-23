#!/usr/bin/env bash
# Build core/ to WebAssembly with its JavaScript bindings into $1, and write
# fixture.json there: the generated city summaries and hashes from a native run, which
# the web tests compare against the WebAssembly build. Needs the
# wasm32-unknown-unknown target and wasm-bindgen-cli at the version core/
# pins.
set -euo pipefail
out="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
cd "$(dirname "$0")/.."
target="${CARGO_TARGET_DIR:-$PWD/target}"
cargo build --locked --release -p felix-metro-core --lib --target wasm32-unknown-unknown
wasm-bindgen --target web --weak-refs --out-dir "$out" \
  "$target/wasm32-unknown-unknown/release/felix_metro_core.wasm"
cargo run --locked --quiet -p felix-metro-core --example fixture >"$out/fixture.json"

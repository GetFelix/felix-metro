# syntax=docker/dockerfile:1.7
# The web app, built and served by nginx on port 80.
# Build from the repository root: docker build -f dev/web.Dockerfile .

# core/ in WebAssembly, with the records from a native run the web tests read.
FROM docker.io/library/rust:1.97-bookworm AS core
# The version must match the wasm-bindgen in Cargo.lock.
RUN rustup target add wasm32-unknown-unknown
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo install wasm-bindgen-cli --version 0.2.129 --locked
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY core core
COPY sim sim
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    core/wasm.sh /out

FROM docker.io/library/node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
# The models and the brand mark live outside web/, shared with the style frame.
COPY prototype/assets ../prototype/assets
COPY docs/brand ../docs/brand
COPY core/src/kinds.rs ../core/src/kinds.rs
COPY web ./
COPY --from=core /out src/core
RUN npm run build

FROM docker.io/library/nginx:1.27-alpine
COPY --from=web /src/web/dist /usr/share/nginx/html

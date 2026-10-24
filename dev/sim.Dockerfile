# syntax=docker/dockerfile:1.7
# The simulation. Configured by SIM_* variables (sim/README.md).
# Build from the repository root: docker build -f dev/sim.Dockerfile .

FROM docker.io/library/rust:1.97-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY core core
COPY sim sim
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p felix-metro-sim --bin sim \
    && cp target/release/sim /usr/local/bin/

FROM docker.io/library/debian:bookworm-slim
# tini so SIGTERM reaches the sim; curl for the speed endpoint, which only
# answers from inside the container (dev/speed.sh).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/sim /usr/local/bin/
USER 65532:65532
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sim"]

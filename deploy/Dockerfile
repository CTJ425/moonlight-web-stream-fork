# Build environment for this fork (v3): Rust (rust-toolchain.toml), the wasm target and
# wasm-bindgen for the uniffi bindings, Node for webpack. See deploy/build.sh.
#   sudo docker build -t mws-build-v3 deploy
FROM debian:trixie
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential clang cmake pkg-config perl xz-utils \
    && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.99.0 \
    -c clippy,rustfmt -t wasm32-unknown-unknown
# Must match the wasm-bindgen version pinned in Cargo.wasm.toml
RUN cargo install wasm-bindgen-cli --version 0.2.128 --locked

ARG NODE_VERSION=26.10.0
RUN curl -sSfL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1

WORKDIR /src

#!/usr/bin/env bash
# Builds web-server and the static frontend inside the mws-build-v3 image (deploy/Dockerfile)
# (one cargo job by default: the 3 GB build VM runs out of memory otherwise)
# and packs them as mws-<commit>.tgz in the repo root: web-server, static/.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
REV="$(git -C "$REPO" rev-parse --short HEAD)"
if ! git -C "$REPO" diff --quiet HEAD; then
    REV="$REV-dirty"
fi

sudo docker run --rm \
    -v "$REPO":/src \
    -v mws-v3-cargo-registry:/opt/cargo/registry \
    -v mws-v3-cargo-git:/opt/cargo/git \
    -v mws-v3-npm:/root/.npm \
    -e CARGO_TARGET_DIR=/src/target-docker \
    -e CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}" \
    -e CARGO_PROFILE_DEV_DEBUG=0 \
    -w /src mws-build-v3 bash -euc '
        cargo build --release --locked
        npm ci --no-audit --no-fund
        CARGO_TARGET_DIR=/src/target-docker npm run build
        rm -rf /tmp/pkg && mkdir -p /tmp/pkg
        cp target-docker/release/web-server /tmp/pkg/
        cp -r dist /tmp/pkg/static
        tar -C /tmp/pkg -czf "mws-'"$REV"'.tgz" web-server static
        chown -R '"$(id -u):$(id -g)"' target-docker dist node_modules web/api_bindings.ts web/uniffi rust_modules "mws-'"$REV"'.tgz" 2>/dev/null || true
    '

echo "$REPO/mws-$REV.tgz"

# Worker image: pinned ffmpeg (with zimg for HDR tonemapping) and Shaka Packager.
# The build fails if ffmpeg lacks what milestone 1 needs (libx264, zscale, loudnorm, bwdif), so
# a bad pin is caught at build time rather than at ingest. 7.0.2 static builds have no libvmaf,
# which milestone 4 needs: it only warns for now.
FROM node:24-bookworm-slim

ARG TARGETARCH
ARG FFMPEG_VERSION=7.0.2
# sha256 of ffmpeg-${FFMPEG_VERSION}-<arch>-static.tar.xz. The host publishes no checksum files
# for versioned releases, so these are pinned here. Empty fails the build.
ARG FFMPEG_SHA256_ARM64=f4149bb2b0784e30e99bdda85471c9b5930d3402014e934a5098b41d0f7201b1
ARG FFMPEG_SHA256_AMD64=abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67
ARG SHAKA_VERSION=v3.4.2

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*

# ffmpeg: release archive, which must match the pinned sha256 for this architecture.
RUN set -eux; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in arm64) sha="${FFMPEG_SHA256_ARM64}" ;; amd64) sha="${FFMPEG_SHA256_AMD64}" ;; esac; \
    test -n "$sha" || { echo "FFMPEG_SHA256_${arch} is not set" >&2; exit 1; }; \
    base="https://johnvansickle.com/ffmpeg/releases"; \
    file="ffmpeg-${FFMPEG_VERSION}-${arch}-static.tar.xz"; \
    curl -fsSL -o "/tmp/${file}" "${base}/${file}"; \
    echo "${sha}  /tmp/${file}" | sha256sum -c -; \
    tar -xJf "/tmp/${file}" -C /tmp; \
    install -m 0755 "/tmp/ffmpeg-${FFMPEG_VERSION}-${arch}-static/ffmpeg" /usr/local/bin/ffmpeg; \
    install -m 0755 "/tmp/ffmpeg-${FFMPEG_VERSION}-${arch}-static/ffprobe" /usr/local/bin/ffprobe; \
    rm -rf /tmp/ffmpeg-* ; \
    missing=""; \
    for f in zscale loudnorm bwdif; do \
      ffmpeg -hide_banner -filters | grep -q " $f " || missing="$missing $f"; \
    done; \
    ffmpeg -hide_banner -encoders | grep -q libx264 || missing="$missing libx264"; \
    test -z "$missing" || { echo "ffmpeg build lacks:$missing" >&2; exit 1; }; \
    ffmpeg -hide_banner -filters | grep -q " libvmaf " || echo "WARNING: no libvmaf in this ffmpeg build (needed from milestone 4)" >&2

# Shaka Packager: first used in milestone 2 (CMAF packaging).
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in amd64) bin=packager-linux-x64 ;; arm64) bin=packager-linux-arm64 ;; esac; \
    curl -fsSL -o /usr/local/bin/packager \
      "https://github.com/shaka-project/shaka-packager/releases/download/${SHAKA_VERSION}/${bin}"; \
    chmod 0755 /usr/local/bin/packager; \
    packager --version

WORKDIR /app
COPY bin ./bin
COPY src ./src
COPY profiles ./profiles

ENTRYPOINT ["node", "/app/bin/ingest.mjs"]

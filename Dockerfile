# RuneLite Web: the official RuneLite launcher on a virtual display, streamed to
# a touch-first web app.
FROM ubuntu:24.04

ARG TARGETARCH
# Leave empty for the latest launcher release, or pin a tag such as "2.7.5".
ARG RUNELITE_LAUNCHER_VERSION=""
ARG NOVNC_VERSION=1.7.0
ARG NOVNC_SHA256=32689f18d6abe96bc6530828a6bd0b9ae33bda07c083a6575ed255b5a8f2e903

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl \
      tigervnc-standalone-server x11-utils matchbox-window-manager \
      python3 python3-aiohttp python3-xlib \
      libx11-6 libxext6 libxrender1 libxtst6 libxi6 libxrandr2 libxxf86vm1 libxcursor1 \
      libgl1 libgl1-mesa-dri libfreetype6 fontconfig fonts-dejavu-core libasound2t64 \
 && rm -rf /var/lib/apt/lists/*

# The official RuneLite launcher from github.com/runelite/launcher. On each
# start it downloads the current RuneLite client, exactly as on a desktop.
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) asset=RuneLite.AppImage ;; \
      arm64) asset=RuneLite-aarch64.AppImage ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    if [ -n "$RUNELITE_LAUNCHER_VERSION" ]; then \
      url="https://github.com/runelite/launcher/releases/download/$RUNELITE_LAUNCHER_VERSION/$asset"; \
    else \
      url="https://github.com/runelite/launcher/releases/latest/download/$asset"; \
    fi; \
    curl -fsSL -o /tmp/RuneLite.AppImage "$url"; \
    chmod +x /tmp/RuneLite.AppImage; \
    cd /opt && /tmp/RuneLite.AppImage --appimage-extract >/dev/null; \
    mv /opt/squashfs-root /opt/runelite; \
    rm /tmp/RuneLite.AppImage

# noVNC (video client only; input goes through the app's own touch layer).
RUN set -eux; \
    curl -fsSL -o /tmp/novnc.tgz "https://registry.npmjs.org/@novnc/novnc/-/novnc-$NOVNC_VERSION.tgz"; \
    echo "$NOVNC_SHA256  /tmp/novnc.tgz" | sha256sum -c -; \
    mkdir /opt/novnc && tar -xzf /tmp/novnc.tgz -C /opt/novnc --strip-components=1; \
    rm /tmp/novnc.tgz

COPY server /opt/rlweb/server
COPY web /opt/rlweb/web
COPY scripts/entrypoint.sh /opt/rlweb/entrypoint.sh

RUN useradd --create-home --uid 1000 --user-group runelite 2>/dev/null \
      || { userdel -r ubuntu && useradd --create-home --uid 1000 --user-group runelite; } \
 && mkdir -p /data/home /data/rlweb && chown -R runelite:runelite /data

USER runelite
# HOME lives on the volume, so RuneLite's ~/.runelite (settings, profiles,
# plugins) survives container rebuilds.
ENV HOME=/data/home \
    APPDIR=/opt/runelite \
    DISPLAY=:1 \
    RLWEB_DATA=/data/rlweb \
    RLWEB_WEB_ROOT=/opt/rlweb/web \
    RLWEB_NOVNC_ROOT=/opt/novnc \
    RLWEB_PORT=8080
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/opt/rlweb/entrypoint.sh"]

FROM ubuntu:24.04

# Purpose: cross-build the OpenCode Desktop app for Windows x64 + arm64 from Linux.
# electron-builder needs wine on non-Windows hosts to run makensis.exe and the
# generated 32-bit uninstaller stub, so i386 support is mandatory.
#
# This image is a BUILD TOOL ONLY. Nothing here installs a service, a systemd unit
# or a restart policy. Every invocation is a one-shot `docker run --rm`; the image
# just sits on disk until you need it. See BUILD-WINDOWS.md.

ENV DEBIAN_FRONTEND=noninteractive
ENV WINEDEBUG="-all"
ENV WINEPREFIX="/root/.wine"

RUN dpkg --add-architecture i386 \
  && for attempt in 1 2 3; do apt-get update && break || sleep 5; done \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git unzip zip xz-utils file python3 build-essential \
    wine wine64 wine32:i386 \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /workspace
CMD ["bash"]
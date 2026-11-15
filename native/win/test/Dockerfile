# Cross-compile + Wine smoke-test image for the Windows helper (see ../README.md).
FROM debian:bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      gcc-mingw-w64-x86-64 binutils-mingw-w64-x86-64 make wine wine64 xvfb xauth xdotool python3 \
    && rm -rf /var/lib/apt/lists/*

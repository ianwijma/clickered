# Throwaway X11 desktop for the E2E suites: Xvfb + fake WM + real helper + Electron.
# Build/run with `npm run test:e2e` from the repo root.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth x11-utils xdotool \
      build-essential pkg-config libx11-dev libxi-dev libxtst-dev \
      python3 python3-xlib \
      libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libatk-bridge2.0-0 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libcups2 libpango-1.0-0 libcairo2 \
      dbus-x11 \
    && rm -rf /var/lib/apt/lists/*

ENV CLICKERED_E2E=1 \
    DISPLAY=:99 \
    ELECTRON_DISABLE_SECURITY_WARNINGS=1 \
    PHYSINPUT=/usr/local/bin/physinput

WORKDIR /app

COPY native/test/physinput.c /tmp/physinput.c
RUN cc -O2 -o /usr/local/bin/physinput /tmp/physinput.c $(pkg-config --cflags --libs x11 xi xtst)

COPY package.json package-lock.json ./
RUN npm ci && node node_modules/electron/install.js

COPY . .
RUN npm run build

ENTRYPOINT ["/app/e2e/run.sh"]

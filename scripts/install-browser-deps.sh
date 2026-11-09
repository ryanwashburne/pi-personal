#!/usr/bin/env bash
# Installs Xvfb, x11vnc, and a real Chrome/Chromium (not the Ubuntu snap stub).
set -euo pipefail

is_snap_stub() {
  local p="$1"
  case "$p" in
    */snap/*) return 0 ;;
  esac
  [ -r "$p" ] || return 1
  head -c 4096 "$p" 2>/dev/null | grep -qiE 'requires the chromium snap|snap install chromium'
}

has_real_chrome() {
  local c p
  for c in google-chrome-stable google-chrome chromium chromium-browser chrome; do
    p="$(command -v "$c" 2>/dev/null || true)"
    if [ -n "$p" ] && [ -x "$p" ] && ! is_snap_stub "$p"; then
      echo "$p"
      return 0
    fi
  done
  for p in /opt/google/chrome/chrome /usr/lib/chromium/chromium; do
    if [ -x "$p" ] && ! is_snap_stub "$p"; then
      echo "$p"
      return 0
    fi
  done
  if find /home/sprite/pi-personal/browser-bin -type f -name chrome -executable 2>/dev/null | grep -q .; then
    find /home/sprite/pi-personal/browser-bin -type f -name chrome -executable | head -n 1
    return 0
  fi
  return 1
}

install_xvfb() {
  if command -v Xvfb >/dev/null && command -v x11vnc >/dev/null; then
    return 0
  fi
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y xvfb x11vnc fonts-liberation fonts-noto-color-emoji dbus-x11
}

install_chrome() {
  if has_real_chrome >/dev/null; then
    echo "chrome already present: $(has_real_chrome)"
    return 0
  fi
  local arch
  arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"
  case "$arch" in
    amd64 | x86_64)
      local tmp
      tmp="$(mktemp -d)"
      curl -fsSL -o "$tmp/chrome.deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
      sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "$tmp/chrome.deb"
      rm -rf "$tmp"
      ;;
    arm64 | aarch64)
      sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 libasound2t64 libasound2 || \
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 libasound2
      mkdir -p /home/sprite/pi-personal/browser-bin
      bunx --bun @puppeteer/browsers install chrome@stable --path /home/sprite/pi-personal/browser-bin
      ;;
    *)
      echo "No Chrome package for architecture $arch" >&2
      return 1
      ;;
  esac
}

if ! command -v sudo >/dev/null; then
  echo "sudo not available; install xvfb, x11vnc, and Google Chrome on the Sprite by hand." >&2
  exit 0
fi

install_xvfb
install_chrome

if ! command -v Xvfb >/dev/null || ! command -v x11vnc >/dev/null; then
  echo "Xvfb/x11vnc still missing after install." >&2
  exit 1
fi
if ! has_real_chrome >/dev/null; then
  echo "No real Chrome/Chromium after install (Ubuntu's chromium-browser is a snap stub)." >&2
  exit 1
fi
echo "browser ready: $(has_real_chrome)"

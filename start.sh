#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

ensure_nvm() {
  export NVM_DIR="$HOME/.nvm"
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    echo "Installing nvm (Node Version Manager)..."
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi

  # shellcheck disable=SC1090
  source "$NVM_DIR/nvm.sh"
  nvm install 22 >/dev/null
  nvm use 22 >/dev/null
}

ensure_rust() {
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi

  if ! command -v cargo >/dev/null 2>&1; then
    echo "Installing Rust toolchain via rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi
}

port_1420_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn '( sport = :1420 )' 2>/dev/null | grep -q LISTEN
    return $?
  fi

  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:1420 -sTCP:LISTEN -t >/dev/null 2>&1
    return $?
  fi

  return 1
}

port_1420_pid() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:1420 -sTCP:LISTEN -t 2>/dev/null | head -n 1
    return
  fi

  if command -v fuser >/dev/null 2>&1; then
    fuser 1420/tcp 2>/dev/null | awk '{print $1}'
    return
  fi
}

handle_dev_port_conflict() {
  if ! port_1420_in_use; then
    return
  fi

  local pid
  pid="$(port_1420_pid || true)"

  if [[ -n "$pid" ]]; then
    local cmdline
    cmdline="$(ps -p "$pid" -o args= 2>/dev/null || true)"

    # Auto-stop only likely stale local dev servers.
    if [[ "$cmdline" == *"vite"* ]] || [[ "$cmdline" == *"tauri dev"* ]]; then
      echo "Port 1420 is in use by an existing dev server (PID $pid). Stopping it..."
      kill "$pid" || true
      return
    fi

    cat <<MSG
Port 1420 is in use by PID $pid:
  $cmdline

Please stop that process, then run ./start.sh again.
MSG
    exit 1
  fi

  cat <<'MSG'
Port 1420 is already in use, but the owning PID could not be identified.
Please free port 1420, then run ./start.sh again.
MSG
  exit 1
}

ensure_tauri_linux_deps() {
  if [[ "${SKIP_DEP_CHECK:-0}" == "1" ]]; then
    return
  fi

  local missing=()

  if ! command -v pkg-config >/dev/null 2>&1; then
    missing+=("pkg-config")
  else
    local probes=(glib-2.0 gobject-2.0 gtk+-3.0 gdk-3.0 webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0 librsvg-2.0)
    for probe in "${probes[@]}"; do
      if ! pkg-config --exists "$probe" 2>/dev/null; then
        missing+=("$probe")
      fi
    done
  fi

  if [[ "${#missing[@]}" -eq 0 ]]; then
    return
  fi

  cat <<MSG
Missing Linux GUI build dependencies for Tauri: ${missing[*]}

The Rust build would fail part-way through without them. On Debian, Ubuntu,
or Linux Mint, install them with:

  sudo apt update
  sudo apt install -y build-essential pkg-config libssl-dev libglib2.0-dev libgtk-3-dev \\
    libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev librsvg2-dev

For other distros, see https://tauri.app/start/prerequisites/ for the
equivalent package list, then run ./start.sh again.
(Set SKIP_DEP_CHECK=1 to bypass this check.)
MSG
  exit 1
}

ensure_nvm
ensure_rust
ensure_tauri_linux_deps
handle_dev_port_conflict

echo "Installing JavaScript dependencies..."
npm install

echo "Starting desktop app..."
npm run tauri dev

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

ensure_tauri_linux_deps_hint() {
  local missing=0
  local probes=(webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0)
  for probe in "${probes[@]}"; do
    if ! pkg-config --exists "$probe" 2>/dev/null; then
      missing=1
    fi
  done

  if [[ "$missing" -eq 1 ]]; then
    cat <<'MSG'
Warning: Some Linux GUI build dependencies for Tauri might be missing.
If the dev run fails, install distro packages such as:
  libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev
MSG
  fi
}

ensure_nvm
ensure_rust
ensure_tauri_linux_deps_hint
handle_dev_port_conflict

echo "Installing JavaScript dependencies..."
npm install

echo "Starting desktop app..."
npm run tauri dev

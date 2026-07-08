# Radiant Pipsqueak

Linux desktop app for fiction text readback using your own OpenAI API key.

## What it does

- First-run setup stores your API key in encrypted local form.
- Paste or edit text snippets (small chunks to a few pages).
- Generate TTS readbacks using selectable voice/model.
- Save generated audio in a local cache linked to each snippet.
- Replay previous audio, regenerate, and run quick voice tests.

## Clone and run

```bash
git clone <your-fork-or-repo-url>
cd RadiantPipsqueak
./start.sh
```

The start script will:

- Install `nvm` if missing and use Node `22`.
- Install `rustup` if missing.
- Install npm dependencies.
- Start the app with `npm run tauri dev`.

If Linux system GUI dependencies are missing, the script prints package hints.

## Manual commands

```bash
npm install
npm run tauri dev
```

Build frontend only:

```bash
npm run build
```

## Data storage

Runtime files are stored in Tauri app directories:

- Config: encrypted key payload.
- Data: SQLite database and generated audio cache.

No API keys are written in plaintext.

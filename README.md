# Music Daypart

LLM-driven NetEase Cloud Music player for time-of-day listening.

Music Daypart uses a Qwen-compatible LLM to turn each time slot's intent and user preferences into NetEase Cloud Music search strategies. It searches through `ncm-cli`, queues all playable songs from the result batch, shuffles the queue, and refreshes automatically on the next hourly slot target or when the queue finishes before the next target.

## Features

- Time-slot music automation with per-slot enable switches, time windows, intent, and keywords.
- LLM-driven search planning and retry strategy. Failed search terms are fed back to the model so it can revise the strategy.
- NetEase Cloud Music playback through `ncm-cli`.
- Browser-based local player UI in Chinese.
- Queue behavior: shuffle all playable search results, play one, enqueue the rest, and refill when finished.
- Runtime controls for play, pause, stop, volume, login, and output device selection.
- Spec files for the agent role, execution, output, and search skill.

## Requirements

- macOS
- Node.js 18+
- `mpv`
- `ncm-cli`
- DashScope/OpenAI-compatible API key for Qwen
- NetEase Cloud Music Open Platform credentials for `ncm-cli`

Optional for audio output selection:

- `SwitchAudioSource`
- `blueutil`

If these audio utilities are missing, the app still runs and uses the system default output.

## Setup

```bash
npm install
cp config/runtime-secrets.example.json config/runtime-secrets.json
```

Fill `config/runtime-secrets.json` or export equivalent environment variables:

```bash
export DASHSCOPE_API_KEY="..."
export MUSIC_NCM_APP_ID="..."
export MUSIC_NCM_PRIVATE_KEY="..."
export MUSIC_NCM_APP_SECRET="..."
```

Install and log in to `ncm-cli` with your own NetEase Cloud Music account:

```bash
ncm-cli login
```

## Run

Web app:

```bash
npm start
```

This starts the backend and frontend, then opens:

```text
http://127.0.0.1:8788
```

Development mode without opening a browser:

```bash
npm run dev
```

CLI checks:

```bash
npm run doctor
npm run run-once
npm run daemon
```

## Configuration

Edit `config/music-workflow.json`.

- `slots[].enabled`: whether the slot is active.
- `slots[].start` / `slots[].end`: local time window.
- `slots[].intent`: LLM search direction, not a literal keyword.
- `slots[].keywords`: user preference terms used as source material for LLM search planning.
- `playback.volume`: default playback volume.
- `playback.outputDeviceName`: optional macOS output device name.

User keywords are not necessarily searched verbatim. The LLM receives the active slot, intent, user keywords, and failure history, then emits `keyword`, `alternate_keywords`, and `search_strategy`. The app searches those LLM-generated keywords.

## Scheduling

Within each enabled slot, playback is scheduled once per hour from the slot start time.

Example: `13:30-17:30` runs at `13:30`, `14:30`, `15:30`, and `16:30`.

If the queue finishes before the next scheduled target and the user did not manually stop playback, the app asks the LLM for a fresh search plan and builds a new shuffled queue.

## Portable Web Package

For another Mac, copy the project folder with its `bin/`, `config/`, `public/`, `scripts/`, `src/`, `vendor/`, `node_modules/`, `package.json`, and `package-lock.json`. Then run:

```bash
node scripts/portable-start.mjs
```

The portable startup script opens the browser UI and keeps services running while the terminal window stays open.

## Security

This repository intentionally ignores:

- `config/runtime-secrets.json`
- `.env*`
- `release/`
- `vendor/`
- `bin/`
- `node_modules/`
- portable zip exports

Never commit personal NetEase login state, API keys, Open Platform private keys, or generated packages that embed those credentials.

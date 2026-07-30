# Notes 101

A Discord bot that joins your voice channel, transcribes the conversation as it happens (Hindi/English/Hinglish code-switching support, via Groq Cloud), and posts clean, structured AI-generated meeting notes when you're done.

## Features

- **`/notes start` / `/notes stop`** — join your voice channel, transcribe every utterance as it's spoken, and post a Markdown summary (meeting overview, discussion points, decisions, action items) when you stop.
- **Speech-to-text via [Groq Cloud](https://console.groq.com/)** (`whisper-large-v3-turbo` by default) — fast, hosted transcription with Hindi/English/Hinglish code-switching, output in Latin script.
- **AI summarization** via Gemini (Vertex AI Express Mode), turning a raw timestamped transcript into structured Markdown notes.
- **Configurable notes channel** (`/notes channel`) — post notes somewhere other than where `/notes stop` was run.
- **Incremental transcription** — each utterance is transcribed as soon as it ends, in parallel with the rest of the conversation still being recorded; nothing waits for the whole session to finish.
- **Resilient to real voice traffic** — corrupted/lost Opus packets and abrupt disconnects (e.g. `/notes stop` mid-sentence) are handled gracefully instead of crashing the bot or losing the rest of an utterance.

## How it works

```
Discord voice (48kHz stereo Opus)
  -> per-speaker utterance capture (silence-endpointed, one pipeline per speaker)
  -> Opus decode (drops corrupted packets instead of dying)
  -> downmix/resample to 16kHz mono PCM
  -> STT via Groq Cloud (whisper-large-v3-turbo)
  -> transcript entries, timestamped at when the speaker started talking
  -> (on /notes stop) Gemini summarization -> Markdown notes file posted to Discord
```

## Requirements

- Node.js 20+ (for native `fetch`/`FormData`/`Blob`, used to call the Groq API)
- A Discord application/bot (token, client ID, and a test guild ID) with the **Voice States**, **Guild Messages**, and **Message Content** intents, and permission to join/speak in voice channels
- A [Groq API key](https://console.groq.com/keys) for speech-to-text
- A Gemini API key ([Vertex AI Express Mode](https://cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode/overview)) for the summarization step

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Create `config.json`** in the project root (gitignored — this holds your bot token, never commit it):
   ```json
   {
       "token": "your-discord-bot-token",
       "clientId": "your-application-client-id",
       "guildId": "your-test-guild-id"
   }
   ```

   Alternatively, set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` (or `CID`), and `DISCORD_GUILD_ID` in `.env` — either works, and env vars take precedence.

3. **Create `.env`** in the project root (gitignored):
   ```bash
   # Groq Cloud STT
   GROQ_API_KEY=your-groq-api-key
   GROQ_MODEL=whisper-large-v3-turbo

   # Optional: guides the model on Hinglish code-switching formatting
   GROQ_WHISPER_PROMPT=This is a Hinglish speech conversation written in Roman script (Latin alphabet), e.g. Haan bhai main code push kar raha hoon.

   # Gemini via Vertex AI Express Mode
   GEMINI_API_KEY=your-gemini-api-key
   GEMINI_MODEL=gemini-2.5-flash
   ```

4. **Register the slash commands** (guild-scoped if `guildId`/`DISCORD_GUILD_ID` is set, for near-instant propagation; otherwise registered globally):
   ```bash
   node deploy.js
   ```

5. **Run the bot**:
   ```bash
   node index.js
   ```

## Commands

| Command | Description |
| --- | --- |
| `/join` | Joins your current voice channel |
| `/leave` | Leaves the voice channel (blocked while a notes session is running) |
| `/notes start` | Joins your voice channel and starts transcribing |
| `/notes stop` | Stops transcribing, summarizes via Gemini, and posts the notes |
| `/notes channel [channel]` | View or set which text channel notes get posted to (needs Manage Channels) |
| `/ping` | Basic liveness check |
| `/restart` | Restarts the bot process (admin only; requires a process manager like pm2/systemd/Docker to actually come back up) |

## Known limitations

- Per-server settings (notes channel) are stored in memory only and reset when the bot restarts.
- `GEMINI_LOCATION` isn't currently honored: Vertex AI Express Mode (API-key auth) doesn't support pinning a region alongside an API key.
- Transcription depends on Groq API availability/latency — no offline fallback.

## Project structure

```
index.js                    # Bot entrypoint: loads commands, logs in, dispatches interactions
deploy.js                   # Registers slash commands with Discord
commands/utility/
  join.js, leave.js         # Basic voice channel join/leave
  notes.js                  # Core /notes command: capture, transcribe, summarize, deliver
  ping.js, restart.js       # Utility/admin commands
lib/
  groqService.js             # Groq Cloud STT (WAV encoding + transcription API call)
  notesSessions.js            # Active notes-session registry (per guild)
  notesChannel.js             # Per-guild "post notes here" override (in-memory)
  geminiService.js            # Gemini summarization prompt + call
  pcmResampler.js              # 48kHz stereo -> 16kHz mono PCM downmixer
  opusDecoder.js                # Opus decoder that drops corrupted packets instead of dying
```

## License

ISC
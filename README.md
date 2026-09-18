# Notes 101

A Discord bot that joins your voice channel, transcribes the conversation as it happens (Hindi/English/Hinglish code-switching support, via Groq Cloud), and posts clean, structured AI-generated meeting notes when you're done.

## Features

- **`/notes start` / `/notes stop`** — join your voice channel, transcribe every utterance as it's spoken, and post a Markdown summary (meeting overview, discussion points, decisions, action items) when you stop.
- **Per-Server API Keys (`/notes setkey`)** — Discord server owners/admins set their own Groq / Gemini API keys. No central API costs for bot owners!
- **Speech-to-text via [Groq Cloud](https://console.groq.com/)** (`whisper-large-v3-turbo` by default) — sub-second transcription with Hindi/English/Hinglish code-switching in Latin script.
- **AI summarization via Groq (Llama 3.3 70B) or Gemini** — converts raw timestamped transcripts into formatted Markdown meeting notes.
- **Configurable notes channel** (`/notes channel`) — post notes somewhere other than where `/notes stop` was run.
- **Incremental transcription** — each utterance is transcribed as soon as it ends; nothing waits for the whole session to finish.
- **Persistent Server Configs** — per-server settings and API keys persist in `guild_configs.json`.
- **Resilient to real voice traffic** — corrupted/lost Opus packets and abrupt disconnects are handled gracefully.

## How it works

```
Discord voice (48kHz stereo Opus)
  -> per-speaker utterance capture (silence-endpointed, one pipeline per speaker)
  -> Opus decode (drops corrupted packets instead of dying)
  -> downmix/resample to 16kHz mono PCM
  -> STT via Groq Cloud (whisper-large-v3-turbo using server API key)
  -> transcript entries, timestamped at when the speaker started talking
  -> (on /notes stop) Groq Llama 3.3 70B / Gemini summarization -> Markdown notes file posted to Discord
```

## Setup & Deployment

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Create `.env`** or `config.json` in root:
   ```env
   CID=your-discord-client-id
   DISCORD_TOKEN=your-discord-bot-token
   ```

3. **Register Slash Commands**:
   ```bash
   node deploy.js
   ```

4. **Run the bot**:
   ```bash
   node index.js
   ```

5. **Configure server API key (in Discord)**:
   A server admin/owner runs:
   ```
   /notes setkey groq_key:<groq_api_key>
   ```

## Slash Commands

| Command                    | Description                                                                 |
| ----------------------------| -----------------------------------------------------------------------------|
| `/notes start`             | Joins your voice channel and starts transcribing                            |
| `/notes stop`              | Stops transcribing, summarizes via AI, and posts the notes                  |
| `/notes setkey`            | Sets Groq / Gemini API keys for the server (Admin only, ephemeral response) |
| `/notes keyinfo`           | View API key status for the server                                          |
| `/notes clearkey`          | Clear API keys saved for the server                                         |
| `/notes channel [channel]` | View or set which text channel notes get posted to (needs Manage Channels)  |
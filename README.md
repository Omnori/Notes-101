# Notes 101

A Discord bot that joins your voice channel, transcribes the conversation as it happens (offline, with Hindi/English/Hinglish code-switching support), and posts clean, structured AI-generated meeting notes when you're done.

## Features

- **`/notes start` / `/notes stop`** — join your voice channel, transcribe every utterance as it's spoken, and post a Markdown summary (meeting overview, discussion points, decisions, action items) when you stop.
- **Two STT engines, switchable per server** via `/notes model`:
  - **Whisper** (default) — handles Hindi/English/Hinglish code-switching, output in Latin script. Slower on CPU.
  - **Vosk** — much faster, but English-only (no code-switching support).
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
  -> STT (Whisper or Vosk, chosen per-server)
  -> transcript entries, timestamped at when the speaker started talking
  -> (on /notes stop) Gemini summarization -> Markdown notes file posted to Discord
```

## Requirements

- Node.js 20+
- A Discord application/bot (token, client ID, and a test guild ID) with the **Voice States**, **Guild Messages**, and **Message Content** intents, and permission to join/speak in voice channels
- A GGML whisper.cpp model file for Hindi/Hinglish transcription (this repo is set up for [Oriserve/Whisper-Hindi2Hinglish-Swift](https://huggingface.co/Oriserve/Whisper-Hindi2Hinglish-Swift), an `openai/whisper-base` fine-tune, converted to GGML)
- *(Optional)* Vosk models, if you want the fast English-only path — see [Models](#models) below
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

3. **Create `.env`** in the project root (gitignored):
   ```bash
   # Path to the GGML whisper.cpp model used for Hindi/English/Hinglish transcription
   WHISPER_MODEL_PATH=./models/whisper-hindi2hinglish-swift.bin

   # Vosk (opt-in via `/notes model`) — maps language codes to model folder paths
   VOSK_MODELS={"en":"./models/vosk-model-small-en-us-0.15","en-in":"./models/vosk-model-small-en-in-0.4"}
   DEFAULT_STT_LANGUAGE=en-in

   # Gemini via Vertex AI Express Mode
   GEMINI_API_KEY=your-gemini-api-key
   GEMINI_MODEL=gemini-3.5-flash
   ```

4. **Add model files** — see [Models](#models) below.

5. **Register the slash commands** (guild-scoped, near-instant propagation):
   ```bash
   node deploy.js
   ```

6. **Run the bot**:
   ```bash
   node index.js
   ```

## Models

Model files live under `models/` (gitignored — download them yourself, they're too large to commit).

| Model | Used for | Download |
| --- | --- | --- |
| `whisper-hindi2hinglish-swift.bin` | Whisper engine (default), Hindi/English/Hinglish | Convert [Oriserve/Whisper-Hindi2Hinglish-Swift](https://huggingface.co/Oriserve/Whisper-Hindi2Hinglish-Swift) to GGML with [whisper.cpp's conversion script](https://github.com/ggml-org/whisper.cpp/tree/master/models) |
| `vosk-model-small-en-us-0.15` | Vosk engine, English (US) | [alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip](https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip) |
| `vosk-model-small-en-in-0.4` | Vosk engine, English (India) | [alphacephei.com/vosk/models/vosk-model-small-en-in-0.4.zip](https://alphacephei.com/vosk/models/vosk-model-small-en-in-0.4.zip) |

Unzip each Vosk model into its own folder under `models/`, and point `VOSK_MODELS` in `.env` at those folder paths. The full list of available Vosk models (other languages/sizes) is at [alphacephei.com/vosk/models](https://alphacephei.com/vosk/models).

### Quantizing the Whisper model (optional, faster inference)

whisper.cpp's `quantize` tool can shrink the model and speed up CPU inference at a small accuracy cost:

```bash
git clone --depth 1 --branch v1.9.1 https://github.com/ggml-org/whisper.cpp.git
cmake -S whisper.cpp -B whisper.cpp/build -DCMAKE_BUILD_TYPE=Release
cmake --build whisper.cpp/build --target whisper-quantize -j4
./whisper.cpp/build/bin/whisper-quantize models/whisper-hindi2hinglish-swift.bin models/whisper-hindi2hinglish-swift.q5_0.bin q5_0
```

Then point `WHISPER_MODEL_PATH` at the quantized file. `q5_0` is a good balance of speed vs. accuracy; more aggressive types (`q4_0`) are faster but riskier on a model this small.

## Commands

| Command | Description |
| --- | --- |
| `/join` | Joins your current voice channel |
| `/leave` | Leaves the voice channel (blocked while a notes session is running) |
| `/notes start` | Joins your voice channel and starts transcribing |
| `/notes stop` | Stops transcribing, summarizes via Gemini, and posts the notes |
| `/notes channel [channel]` | View or set which text channel notes get posted to (needs Manage Channels) |
| `/notes model [engine]` | View or set the STT engine (Whisper / Vosk) for this server — must be set **before** `/notes start` |
| `/ping` | Basic liveness check |
| `/restart` | Restarts the bot process (admin only; requires a process manager like pm2/systemd/Docker to actually come back up) |

## Performance notes

- Transcription is **CPU-only** by default. whisper.cpp pays a largely fixed compute cost per utterance (its encoder always processes a full 30-second context internally, regardless of the actual utterance length), so per-utterance latency doesn't scale down much for short utterances — this is the main cost driver on modest hardware.
- Transcriptions are serialized one-at-a-time per process (not per-utterance-parallel) since a single transcription already uses all available CPU threads.
- GPU backends (CUDA, Vulkan) are bundled with the underlying native module but not enabled by default — enabling them would need a code change plus a machine with a compatible GPU/drivers.
- If Whisper is too slow for your use case and your meetings are English-only, `/notes model` lets you switch to Vosk, which is dramatically faster (no code-switching support, so it's a real accuracy/speed trade-off, not a free win).

## Known limitations

- Per-server settings (notes channel, STT engine/language) are stored in memory only and reset when the bot restarts.
- Vosk has no Hindi/English code-switching support — it's an English-only fallback, not a Whisper replacement.
- `GEMINI_LOCATION` isn't currently honored: Vertex AI Express Mode (API-key auth) doesn't support pinning a region alongside an API key.

## Project structure

```
index.js                    # Bot entrypoint: loads commands, logs in, dispatches interactions
deploy.js                   # Registers slash commands with Discord
commands/utility/
  join.js, leave.js         # Basic voice channel join/leave
  notes.js                  # Core /notes command: capture, transcribe, summarize, deliver
  ping.js, restart.js       # Utility/admin commands
lib/
  whisperService.js         # Whisper.cpp model context + serialized transcription queue
  voskService.js             # Vosk model loading + per-call transcription
  sttEngine.js               # Per-guild STT engine/language selection (in-memory)
  sttLanguage.js              # Per-guild Vosk language override (in-memory)
  notesSessions.js            # Active notes-session registry (per guild)
  notesChannel.js             # Per-guild "post notes here" override (in-memory)
  geminiService.js            # Gemini summarization prompt + call
  pcmResampler.js              # 48kHz stereo -> 16kHz mono PCM downmixer
  opusDecoder.js                # Opus decoder that drops corrupted packets instead of dying
models/                       # Model files (gitignored, see Models above)
```

## License

ISC

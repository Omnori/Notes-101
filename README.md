# Soren

Soren is a stateful, Notion-grounded corporate assistant and voice-channel meeting summarizer for Discord. Soren is built to understand organizational context from a Notion "Central Wiki," support natural mentions, update records, and keep a cached, searchable database of workspace items with SQLite FTS5.

---

## Features

### Notion-Grounded Corporate Assistant
- **`/notion setup`** — Link a Central Wiki from Notion to Soren. Soren automatically maps the workspace into a topological Table of Contents and injects it into its system instructions.
- **`/notion scan`** — Recursively crawl Notion pages and databases, convert blocks to markdown, extract meta-properties (Assignee, Status, Deadline), and cache them in a local SQLite database.
- **`/notion status`** — Check indexing, sync, and mapping statistics.
- **`/notion link-member`** — Map Discord display names to Notion workspace users for context-aware task assignments and notifications.
- **`/ask`** — Query Soren about server wikis, documentation, ongoing sprint items, or action logs.
- **Stateful Conversational Memory & Multi-Turn Tool Execution** — Mention `@Soren` in any text channel to chat naturally. Soren leverages multi-turn tool execution (e.g., search workspace, read pages, update docs, create tasks) before returning fully formatted Markdown answers.
- **SQLite FTS5 Full-Text Search with Triggers** — Instantly search indexed content using native SQLite FTS5, kept automatically in sync via database-level triggers.

### Voice Channel Summarizer & Transcriber
- **`/notes start` / `/notes stop`** — Soren joins your voice channel, transcribes conversations in real-time (with multilingual Hindi/English/Hinglish support via Groq Whisper), and posts beautiful, structured AI-generated meeting notes when done.
- **Per-Server API Keys (`/notes setkey`)** — Server owners set their own Groq and Gemini API keys.
- **Resilient Audio Pipelines** — Handles packet losses and abrupt disconnects gracefully, using an incremental speaker-endpointed pipeline.

---

## How It Works

```
                      +-------------------+
                      |   Discord Guild   |
                      +---------+---------+
                                |
                  +-------------+-------------+
                  |                           |
                  v                           v
         [Text / Mentions]             [Voice Channel]
                  |                           |
                  v                           v
          Grounded Assistant           Opus Audio Stream
                  |                           |
                  v                           v
           Gemini / Groq LLM          Speaker-Endpointed
                  |                        Pipeline
                  v                           |
         +--------+--------+                  v
         |  Tool Execution |             STT via Groq
         |  (Search, Read, |                  |
         |  Update, Task)  |                  v
         +--------+--------+         Incremental Transcription
                  |                           |
                  v                           v
          SQLite FTS5 Cache         Llama 3.3 / Gemini Notes
                  ^                           |
                  |                           v
          Recursive Scanner            Structured Markdown
                  |
                  v
         Notion Workspace API
```

---

## Comprehensive Setup & Deployment Guide

Follow this step-by-step guide to configure, deploy, and use Soren.

### 1. Prerequisites & System Dependencies

Before running the application, make sure your host machine has Node.js and the necessary audio processing libraries installed.

#### Install Node.js
- Node.js version 18.0.0 or higher is required.

#### Install ffmpeg and libopus
Soren requires `ffmpeg` and native voice development libraries for real-time Discord audio recording and transcription.

- **Debian/Ubuntu**:
  ```bash
  sudo apt-get update
  sudo apt-get install -y ffmpeg build-essential libopus-dev autoconf libtool
  ```
- **macOS** (via Homebrew):
  ```bash
  brew install ffmpeg opus
  ```
- **Arch Linux**:
  ```bash
  sudo pacman -S ffmpeg opus autoconf libtool make gcc
  ```

---

### 2. Creating a Discord Bot Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application**, give it a name (e.g., "Soren"), and click **Create**.
3. Under the **Bot** tab:
   - Click **Reset Token** and copy the token. This is your `DISCORD_TOKEN`.
   - Scroll down to **Privileged Gateway Intents** and enable:
     - **Presence Intent**
     - **Server Members Intent**
     - **Message Content Intent** (Crucial for reading messages and mentions)
4. Under the **OAuth2** tab:
   - Click **URL Generator**.
   - Under **Scopes**, select `bot` and `applications.commands`.
   - Under **Bot Permissions**, select:
     - **Manage Channels** (needed to read or restrict posting channels)
     - **Send Messages**
     - **Send Messages in Threads**
     - **Embed Links**
     - **Attach Files**
     - **Read Message History**
     - **Connect** (Voice permission)
     - **Speak** (Voice permission)
   - Copy the generated URL at the bottom and open it in your browser to invite the bot to your Discord server.

---

### 3. Setting Up a Notion Integration

To connect Soren with your Notion workspace:

1. Go to the [Notion Integrations Portal](https://www.notion.so/my-integrations).
2. Click **New integration**.
3. Select the workspace where your Central Wiki will live, name it (e.g., "Soren Connection"), and set the capabilities to allow Read, Update, and Insert permissions. Click **Submit**.
4. Copy the **Internal Integration Secret**. This is your Notion Integration Token.
5. In your Notion workspace, select or create the root page of your wiki (for example, a blank page titled "Central Wiki").
6. On this page, click the three dots (`...`) in the top-right corner.
7. Under **Connections**, click **Connect to**, search for your integration name ("Soren Connection"), and confirm. Soren now has permission to read and build databases under this parent page.

---

### 4. Configuration and Local Deployment

1. **Clone the repository and install dependencies**:
   ```bash
   git clone <repository-url>
   cd Notes101
   npm install
   ```

2. **Create a `.env` file** in the project root directory:
   ```env
   CID=your-discord-client-id
   DISCORD_TOKEN=your-discord-bot-token
   ```

3. **Deploy Slash Commands**:
   Register Soren's commands to the Discord API:
   ```bash
   node deploy.js
   ```

4. **Start Soren**:
   Run the bot application:
   ```bash
   node index.js
   ```
   On startup, Soren will initialize a local SQLite database named `soren.sqlite` to handle configurations, cache, full-text indexes, and audio sessions.

---

## Workspace Onboarding & Usage Guide

Once Soren is running in your server, follow these steps to configure it within Discord.

### Step 1: Provide API Keys to Soren
Soren operates with per-server API keys. An administrator must run this command in the server:
```
/notes setkey groq_key:<your_groq_api_key> gemini_key:<your_gemini_api_key>
```
*Note: Your keys are encrypted at rest with AES-256-GCM in the SQLite database and are never displayed publicly.*

To check configuration status:
```
/notes keyinfo
```

---

### Step 2: Establish the Notion Central Wiki
Link Soren to your shared Notion workspace by running:
```
/notion setup token:<your_notion_integration_secret> wiki:<your_root_page_id>
```
*How to find the Wiki Page ID: The Page ID is the 32-digit alphanumeric string at the end of your Notion page's URL (e.g., in `https://www.notion.so/Central-Wiki-3d9a1f2bc34547908bde1c71289df382`, the ID is `3d9a1f2bc34547908bde1c71289df382`).*

When setup is executed on a blank root page, Soren automatically provisions a complete workspace template including:
- **Top Sprint Notice & Focus Board** (Custom callout banner)
- **2-Column Operational Grid**:
  - Left Column: Active Products & Tech Lab
  - Right Column: Clients & Partnerships
- **Administrative Registries**:
  - Meetings Database (Action-items & Summaries tracker)
  - Org Info Page (Dynamic corporate facts repository)
  - Action Items Database (Master task management list)
  - Team Members Directory

---

### Step 3: Run the Scanner
Populate Soren's local full-text search index by running:
```
/notion scan
```
Soren recursively crawls the workspace page hierarchy and databases, converting them into searchable markdown. Check sync statistics using:
```
/notion status
```

---

### Step 4: Map Your Team Members
Map your server members to their Notion profiles to enable automated assignment tracking:
```
/notion link-member member:@DiscordUser notion_name:"Notion Account Name/Email"
```

---

### Step 5: Interact with Soren
Now Soren is fully grounded and ready!

- **Grounded Q&A**: Ask any workspace or documentation question using:
  ```
  /ask question:Who is currently assigned to the Stripe Webhook bug?
  ```
- **Text Mentions**: Mention `@Soren` in any text channel to chat naturally. You can ask it to:
  - Search documents: *"@Soren, find any files mentioning onboarding guidelines."*
  - Read specific pages: *"@Soren, read the Product Spec document."*
  - Update sections: *"@Soren, add a bullet to Active Products saying that Soren bot integration tests are passing."*
  - Create and edit tasks: *"@Soren, assign a new high priority task 'Fix Discord connection' to @User with deadline Monday."*
  Soren will run a multi-turn reasoning loop to query its FTS5 index, retrieve the pages, execute the actions on Notion, and reply with a concise markdown answer.

- **Voice Channel Summaries**: Invite Soren to transcribe and summarize a meeting:
  1. Join a voice channel.
  2. Start recording: `/notes start`
  3. Conduct your meeting. Soren transcribes speech in real-time, matching words to specific speakers.
  4. Stop recording: `/notes stop`
  Soren will automatically process the audio transcript, generate a structured summary, list action items, sync them back to your Notion Meetings registry, and post a beautiful report in your configured Discord channel!

---

## Slack & Slash Commands Reference

| Command | Category | Parameters | Description |
| :--- | :--- | :--- | :--- |
| `/notes setkey` | System Configuration | `groq_key`, `gemini_key` | Ephemerally saves and encrypts your server's LLM provider API keys. |
| `/notes keyinfo` | System Configuration | None | Displays which keys are currently configured (masked). |
| `/notes clearkey` | System Configuration | None | Deletes all server API keys from SQLite storage. |
| `/notes channel` | Voice & Meetings | `channel` | Configures which text channel Soren should post meeting summaries to. |
| `/notes start` | Voice & Meetings | None | Summons Soren to your current voice channel to start real-time transcription. |
| `/notes stop` | Voice & Meetings | None | Directs Soren to leave the channel, compile the transcript, and post a structured meeting report. |
| `/notion setup` | Notion Integration | `token`, `wiki` | Links Soren with your Notion integration token and root Central Wiki page. |
| `/notion scan` | Notion Integration | None | Triggers a full, recursive workspace scan to refresh the FTS5 search index. |
| `/notion status` | Notion Integration | None | Displays cache statistics, total mapped pages, and last scan timestamps. |
| `/notion link-member` | Notion Integration | `member`, `notion_name` | Connects a Discord server member to their Notion account profile. |
| `/ask` | Workspace Search | `question` | Directly queries Soren's local full-text search index using AI-driven context grounding. |

---

## Troubleshooting

- **Audio issues or Bot won't join voice**:
  Ensure that you have installed `ffmpeg` and that the bot has `Connect` and `Speak` permissions in the target channel.
- **Empty search results or `/ask` failures**:
  Ensure you have completed a `/notion scan` successfully. Run `/notion status` to verify that pages have been cached.
- **Notion Permission Errors**:
  Confirm that your integration Connection is shared with the root Central Wiki page in Notion. If Soren cannot read child databases, make sure they are nested under the connected parent page.

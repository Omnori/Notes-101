# Notes 101: Notion-Grounded Server Assistant Plan

## 1. Overview & Vision

Transform Notes 101 from a voice transcription bot into a **dedicated, Notion-grounded company assistant** for a Discord server. 

The bot serves as the central brain of the server:
- **Central Wiki as Single Source of Truth**: The server owner supplies their Model API key (Groq/Gemini), Notion API token, and a Central Wiki Root Page ID.
- **Dynamic Context (Wiki TOC)**: The bot scans the Central Wiki, generates a comprehensive Table of Contents (TOC) Markdown blueprint, and injects it as real-time context into the LLM prompt.
- **Strict Notion Grounding with Tool Calling**: The assistant answers questions in Discord chat via `/ask` using on-demand tools (`read_page`, `search_workspace`, `create_page`, `update_page`, `delete_page`) without hallucinating facts.
- **Voice Meeting Audio to Notion Tasks**: In voice calls, the bot records per-speaker utterances (Groq Whisper), summarizes key points per speaker, and automatically creates assigned tasks in the Central Wiki tagged with each member's Discord ID / name.
- **Chat-First Responses (No TTS overhead)**: Responses to `/ask` or questions are sent directly in Discord chat with markdown formatting and Notion links.

---

## 2. Storage Strategy: Why SQLite Over Firebase

| Criteria | **SQLite (`better-sqlite3`)** | **Firebase (Firestore / RTDB)** | Decision Rationale |
| :--- | :--- | :--- | :--- |
| **Read Latency** | **< 0.5 ms** (In-process memory/disk) | **80 – 250 ms** (Network hop) | Instant prompt injection for `/ask` and voice context. |
| **Bot Architecture** | **100% matched** (Stateful 24/7 Node.js daemon) | Adds external cloud dependency | Discord voice bots must run on persistent servers anyway. |
| **Cost & Quotas** | **$0 / Unlimited local ops** | Document read/write quotas | Wiki scans and meeting transcripts won't incur API bill shocks. |
| **Full-Text Search** | **Built-in FTS5** | Requires 3rd-party (Algolia/Typesense) | Fast keyword search across all Notion pages. |
| **Security & Privacy**| Kept strictly on the local host | Stored on third-party cloud | Notion keys and company tasks remain private. |

---

## 3. High-Level System Architecture

```mermaid
flowchart TD
    subgraph Discord["Discord Server"]
        U1["User in Voice Call"] -->|Opus Voice Stream| REC["Per-Speaker Audio Receiver"]
        U2["User in Text Chat"] -->|/ask or @Bot| ASK["Assistant Chat Handler"]
    end

    subgraph Transcription["Voice Processing"]
        REC --> STT["Groq Whisper (16kHz PCM)"]
        STT --> TRANS["Per-Speaker Transcripts"]
    end

    subgraph MeetingPipeline["Meeting-to-Notion Pipeline"]
        TRANS --> SUMM["LLM Meeting Summarizer (Gemini/Groq)"]
        SUMM --> EXTRACT["Extract Action Items per Discord User"]
        EXTRACT --> CREATE_TASK["Notion Write Task Tool"]
    end

    subgraph NotionSync["Notion Integration"]
        NOTION_API["Notion API"] <--> SYNC["Wiki Scanner & Sync Engine"]
        CREATE_TASK --> NOTION_API
    end

    subgraph Storage["Local SQLite Storage (better-sqlite3)"]
        SYNC --> WIKI_DB["guild_notion_wiki (TOC Blueprint)"]
        SYNC --> ITEMS_DB["notion_items + FTS5 Index"]
        DB_KEYS["guild_settings (Encrypted API Keys)"]
        USER_MAP["guild_user_mappings (Discord ID <-> Notion Member)"]
    end

    subgraph AssistantEngine["Grounded Assistant Engine"]
        WIKI_DB -->|Dynamic Context (TOC)| PROMPT["System Prompt + Wiki Blueprint"]
        ASK --> PROMPT
        PROMPT --> LLM["LLM Reasoner (Gemini / Groq)"]
        LLM <-->|Function Calling| TOOLS["Notion Tools (read/search/create/update)"]
        TOOLS <--> ITEMS_DB
        TOOLS <--> NOTION_API
        LLM -->|Chat Response with Notion Links| CHAT_REPLY["Discord Text Reply"]
    end
```

---

## 4. SQLite Database Schema (`lib/db.js`)

Database location: `data/notes101.db` (using `better-sqlite3`).

### 4.1. `guild_settings`
Replaces `guild_configs.json`. Encrypts sensitive tokens at rest using AES-256-GCM.
- `guild_id` (TEXT PRIMARY KEY)
- `encrypted_groq_key` (TEXT)
- `encrypted_gemini_key` (TEXT)
- `encrypted_notion_key` (TEXT)
- `notes_channel_id` (TEXT)
- `summary_provider` (TEXT DEFAULT 'groq')
- `created_at` (INTEGER)
- `updated_at` (INTEGER)

### 4.2. `guild_notion_wiki`
Stores the high-level Central Wiki structure and dynamic context.
- `guild_id` (TEXT PRIMARY KEY)
- `wiki_root_page_id` (TEXT NOT NULL)
- `wiki_toc_markdown` (TEXT) — Precomputed Markdown blueprint injected into `/ask` prompt.
- `structure_json` (TEXT) — Recursive JSON tree of child pages and databases.
- `last_scanned_at` (INTEGER)

### 4.3. `notion_items` & `notion_items_fts`
Cached pages and database items for rapid search and tool execution.
- `id` (TEXT PRIMARY KEY) — Notion Page / Item UUID
- `guild_id` (TEXT NOT NULL)
- `parent_id` (TEXT)
- `database_id` (TEXT)
- `type` (TEXT) — `'page'`, `'database'`, `'task'`, `'doc'`
- `title` (TEXT)
- `status` (TEXT)
- `assignee` (TEXT)
- `due_date` (TEXT)
- `properties_json` (TEXT)
- `content_markdown` (TEXT)
- `url` (TEXT)
- `updated_at` (INTEGER)
- **FTS5 Virtual Table**: `notion_items_fts` indexing `title` and `content_markdown`.

### 4.4. `guild_user_mappings`
Maps Discord members to their Notion profiles.
- `guild_id` (TEXT)
- `discord_user_id` (TEXT)
- `discord_display_name` (TEXT)
- `notion_user_name` (TEXT)
- `notion_user_id` (TEXT)
- PRIMARY KEY (`guild_id`, `discord_user_id`)

### 4.5. `meeting_sessions` & `transcripts`
Persists past meeting voice notes and transcripts.
- `meeting_sessions`: `session_id`, `guild_id`, `channel_id`, `started_at`, `ended_at`, `summary_markdown`
- `transcripts`: `id`, `session_id`, `speaker_id`, `speaker_name`, `timestamp`, `text`

---

## 5. Dynamic Context & Grounding Strategy

### Two-Tier Grounding Architecture
1. **Tier 1 (Upfront Dynamic Context - Wiki Blueprint)**:
   On every user query, the pre-scanned `wiki_toc_markdown` is injected into the system prompt:
   ```markdown
   # Current Workspace Blueprint (Central Wiki)
   - 📁 Projects / Roadmaps [ID: a1b2]
     - 📄 Q3 Backend Refactor [ID: c3d4]
     - 📄 Mobile App v2 [ID: e5f6]
   - 📊 Team Tasks & Sprints [ID: g7h8]
   - 📁 Engineering Docs [ID: i9j0]
   ```
   *Why:* The model immediately understands workspace topology without blowing through token limits on full page bodies.

2. **Tier 2 (On-Demand Tool Calling)**:
   When the user asks for specific content, tasks, or modifications, the model invokes explicit tools:
   - `read_page(page_id)`: Fetches full block contents from Notion/cache.
   - `search_workspace(query)`: FTS5 search across local cache + fallback to Notion search API.
   - `create_page(parent_page_id, title, content_markdown)`: Creates a new page or document.
   - `update_page(page_id, content_markdown, properties)`: Updates content or status.
   - `delete_page(page_id)`: Archives a page in Notion.
   - `create_user_task(discord_user_id, task_title, due_date, priority)`: Creates a task assigned to a team member.

3. **Anti-Hallucination Policy**:
   The system prompt explicitly commands:
   > "You are the server's dedicated company assistant. All facts, task statuses, assignees, and deadlines MUST be verified from the Notion tools. If an item cannot be found in Notion, state clearly that it does not exist. Never invent projects or dates."

---

## 6. Voice Meetings → Notion Tasks Pipeline

When `/notes stop` is called:
1. Per-speaker utterances are transcribed and aggregated into `session.transcript`.
2. The summarizer (Gemini / Groq Llama 3.3) outputs:
   - Overall Meeting Summary & Key Decisions.
   - Per-Speaker Action Items:
     ```json
     [
       {
         "discord_user_id": "123456789",
         "speaker_name": "Alex",
         "task": "Finalize Stripe webhook handling",
         "due_date": "2026-09-18",
         "priority": "High"
       }
     ]
     ```
3. The bot connects to the Central Wiki Tasks Database:
   - Creates a card for each action item.
   - Assigns it to the member (mapping `discord_user_id` -> Notion User or noting their Discord tag).
4. Creates a new Meeting Notes sub-page in Notion under the Central Wiki.
5. In Discord, posts the summary with clickable links to the newly created Notion tasks.

---

## 7. Chat Commands & User Interaction

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `/notion setup` | `notion_token`, `central_wiki_id` | Configures Notion credentials and root Central Wiki page. |
| `/notion scan` | _(none)_ | Recursively scans Central Wiki, updates SQLite FTS5, and regenerates TOC Markdown. |
| `/notion link-member` | `discord_user`, `notion_name` | Maps a Discord member to a Notion user. |
| `/notion status` | _(none)_ | Shows connected Central Wiki title, last sync time, and page counts. |
| `/ask` | `question` | Primary assistant command: asks questions, creates pages, updates tasks via chat. |
| `@Bot <question>` | Message content | Natural conversational trigger in allowed channels. |
| `/notes start` | _(none)_ | Joins voice channel, records per-speaker utterances. |
| `/notes stop` | _(none)_ | Ends meeting, generates notes, creates Notion tasks, posts summary in chat. |

---

## 8. Phased Implementation Roadmap

### Phase 1: SQLite Database Engine & Key Migration
- [ ] Install `better-sqlite3`.
- [ ] Implement `lib/db.js` with schema creation, AES-256 key encryption/decryption, and connection pooling.
- [ ] Migrate [`lib/guildConfig.js`](file:///home/yetri/Everything-Code/Ventures/Omnori/Notes101/lib/guildConfig.js) to read/write from SQLite instead of `guild_configs.json`.

### Phase 2: Notion Service & Wiki Scanner
- [ ] Install `@notionhq/client`.
- [ ] Implement `lib/notionService.js`:
  - Test Notion connection and read root page title/metadata.
  - Recursive tree scanner (pages & child databases).
  - TOC Markdown generator (producing the workspace blueprint).
  - Save TOC and items into `guild_notion_wiki` and `notion_items` with FTS5 indexing.
- [ ] Create `/notion setup`, `/notion scan`, and `/notion status` slash commands.

### Phase 3: Dynamic Assistant Engine & `/ask` Command
- [ ] Implement `lib/assistantEngine.js`:
  - Dynamically injects `wiki_toc_markdown` into system prompt.
  - Registers function calling tools: `read_page`, `search_workspace`, `create_page`, `update_page`, `delete_page`.
  - Handles multi-turn tool loops with Gemini / Groq.
- [ ] Implement `/ask` slash command and `@Bot` mention listener in Discord text channels.

### Phase 4: Meeting Audio → Notion Tasks Pipeline
- [ ] Update [`commands/utility/notes.js`](file:///home/yetri/Everything-Code/Ventures/Omnori/Notes101/commands/utility/notes.js):
  - Add structured action-item extraction per speaker.
  - Write action items directly to Notion Central Wiki Tasks.
  - Save meeting sessions and transcripts to SQLite tables.
  - Return Notion task links in the Discord meeting summary reply.

### Phase 5: Verification & End-to-End Testing
- [ ] Test SQLite migration with existing guild configurations.
- [ ] Test `/notion setup` and `/notion scan` on sample Notion wiki pages.
- [ ] Test `/ask` question-answering with tool calls.
- [ ] Test voice meeting stop with auto-task generation in Notion.

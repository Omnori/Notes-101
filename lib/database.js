const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../notes101.sqlite');
const LEGACY_JSON_PATH = path.join(__dirname, '../guild_configs.json');

const db = new Database(DB_PATH);

// Optimize SQLite for high concurrency across multiple Discord servers
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
    CREATE TABLE IF NOT EXISTS guild_configs (
        guild_id TEXT PRIMARY KEY,
        groq_api_key TEXT,
        gemini_api_key TEXT,
        summary_provider TEXT DEFAULT 'groq',
        groq_model TEXT,
        gemini_model TEXT,
        notes_channel_id TEXT,
        daily_request_limit INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meeting_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        channel_id TEXT,
        channel_name TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        duration_seconds INTEGER DEFAULT 0,
        participant_count INTEGER DEFAULT 0,
        participants TEXT,
        summary_provider TEXT,
        summary_model TEXT,
        transcript_entries_count INTEGER DEFAULT 0,
        status TEXT NOT NULL, -- 'completed', 'failed', 'empty'
        error_message TEXT,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        service TEXT NOT NULL, -- 'groq_stt', 'groq_summary', 'gemini_summary'
        model TEXT,
        status TEXT NOT NULL, -- 'success', 'rate_limited', 'error'
        tokens_used INTEGER DEFAULT 0,
        error_message TEXT,
        created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_guild ON meeting_sessions(guild_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_created ON meeting_sessions(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_guild_time ON api_requests(guild_id, created_at);
`);

// Migration safeguard for existing databases
try {
    db.exec(`ALTER TABLE guild_configs ADD COLUMN daily_request_limit INTEGER DEFAULT 0`);
} catch {
    // Column already exists
}

// Prepared statements for guild configurations and request logging
const stmts = {
    getGuild: db.prepare('SELECT * FROM guild_configs WHERE guild_id = ?'),
    upsertGuild: db.prepare(`
        INSERT INTO guild_configs (
            guild_id, groq_api_key, gemini_api_key, summary_provider, groq_model, gemini_model, notes_channel_id, created_at, updated_at
        ) VALUES (
            @guild_id, @groq_api_key, @gemini_api_key, @summary_provider, @groq_model, @gemini_model, @notes_channel_id, @created_at, @updated_at
        )
        ON CONFLICT(guild_id) DO UPDATE SET
            groq_api_key = COALESCE(@groq_api_key, groq_api_key),
            gemini_api_key = COALESCE(@gemini_api_key, gemini_api_key),
            summary_provider = COALESCE(@summary_provider, summary_provider),
            groq_model = COALESCE(@groq_model, groq_model),
            gemini_model = COALESCE(@gemini_model, gemini_model),
            notes_channel_id = COALESCE(@notes_channel_id, notes_channel_id),
            updated_at = @updated_at
    `),
    clearGuildKeys: db.prepare(`
        UPDATE guild_configs
        SET groq_api_key = NULL,
            gemini_api_key = NULL,
            summary_provider = 'groq',
            groq_model = NULL,
            gemini_model = NULL,
            updated_at = ?
        WHERE guild_id = ?
    `),
    setChannelId: db.prepare(`
        INSERT INTO guild_configs (guild_id, notes_channel_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
            notes_channel_id = excluded.notes_channel_id,
            updated_at = excluded.updated_at
    `),
    setQuota: db.prepare(`
        INSERT INTO guild_configs (guild_id, daily_request_limit, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
            daily_request_limit = excluded.daily_request_limit,
            updated_at = excluded.updated_at
    `),
    insertSession: db.prepare(`
        INSERT INTO meeting_sessions (
            guild_id, channel_id, channel_name, started_at, ended_at, duration_seconds,
            participant_count, participants, summary_provider, summary_model,
            transcript_entries_count, status, error_message, created_at
        ) VALUES (
            @guild_id, @channel_id, @channel_name, @started_at, @ended_at, @duration_seconds,
            @participant_count, @participants, @summary_provider, @summary_model,
            @transcript_entries_count, @status, @error_message, @created_at
        )
    `),
    getGuildStats: db.prepare(`
        SELECT 
            COUNT(*) as total_meetings,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed_meetings,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed_meetings,
            COALESCE(SUM(duration_seconds), 0) as total_duration_seconds
        FROM meeting_sessions
        WHERE guild_id = ?
    `),
    getRecentSessions: db.prepare(`
        SELECT * FROM meeting_sessions
        WHERE guild_id = ?
        ORDER BY created_at DESC
        LIMIT ?
    `),
    insertApiRequest: db.prepare(`
        INSERT INTO api_requests (
            guild_id, service, model, status, tokens_used, error_message, created_at
        ) VALUES (
            @guild_id, @service, @model, @status, @tokens_used, @error_message, @created_at
        )
    `),
    getDailyRequestStats: db.prepare(`
        SELECT 
            COUNT(*) as total_requests_24h,
            COALESCE(SUM(CASE WHEN service = 'groq_stt' THEN 1 ELSE 0 END), 0) as stt_requests_24h,
            COALESCE(SUM(CASE WHEN service IN ('groq_summary', 'gemini_summary') THEN 1 ELSE 0 END), 0) as summary_requests_24h,
            COALESCE(SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END), 0) as rate_limit_hits_24h
        FROM api_requests
        WHERE guild_id = ? AND created_at >= ?
    `),
    getLifetimeRequestStats: db.prepare(`
        SELECT COUNT(*) as total_lifetime_requests
        FROM api_requests
        WHERE guild_id = ?
    `),
    countRequestsSince: db.prepare(`
        SELECT COUNT(*) as total
        FROM api_requests
        WHERE guild_id = ? AND created_at >= ?
    `),
};

// Automatic one-time migration from legacy guild_configs.json if present
function migrateFromLegacyJson() {
    try {
        if (!fs.existsSync(LEGACY_JSON_PATH)) return;
        const raw = fs.readFileSync(LEGACY_JSON_PATH, 'utf-8');
        if (!raw.trim()) return;
        const legacyData = JSON.parse(raw);
        const now = Date.now();

        const insertMany = db.transaction((configs) => {
            for (const [guildId, cfg] of Object.entries(configs)) {
                if (!cfg || typeof cfg !== 'object') continue;
                stmts.upsertGuild.run({
                    guild_id: guildId,
                    groq_api_key: cfg.groqApiKey || null,
                    gemini_api_key: cfg.geminiApiKey || null,
                    summary_provider: cfg.summaryProvider || 'groq',
                    groq_model: cfg.groqModel || null,
                    gemini_model: cfg.geminiModel || null,
                    notes_channel_id: cfg.notesChannelId || null,
                    created_at: now,
                    updated_at: now,
                });
            }
        });

        insertMany(legacyData);
        console.log('[database] Successfully migrated legacy guild_configs.json into SQLite database.');
    } catch (err) {
        console.error('[database] Migration from guild_configs.json failed:', err);
    }
}

migrateFromLegacyJson();

function getGuildConfig(guildId) {
    const row = stmts.getGuild.get(guildId);
    if (!row) return {};
    return {
        groqApiKey: row.groq_api_key || undefined,
        geminiApiKey: row.gemini_api_key || undefined,
        summaryProvider: row.summary_provider || 'groq',
        groqModel: row.groq_model || undefined,
        geminiModel: row.gemini_model || undefined,
        notesChannelId: row.notes_channel_id || null,
        dailyRequestLimit: row.daily_request_limit || 0,
    };
}

function setGuildKeys(guildId, { groqApiKey, geminiApiKey, summaryProvider, groqModel, geminiModel }) {
    const now = Date.now();
    stmts.upsertGuild.run({
        guild_id: guildId,
        groq_api_key: groqApiKey !== undefined ? groqApiKey : null,
        gemini_api_key: geminiApiKey !== undefined ? geminiApiKey : null,
        summary_provider: summaryProvider !== undefined ? summaryProvider : null,
        groq_model: groqModel !== undefined ? groqModel : null,
        gemini_model: geminiModel !== undefined ? geminiModel : null,
        notes_channel_id: null,
        created_at: now,
        updated_at: now,
    });
}

function clearGuildKeys(guildId) {
    stmts.clearGuildKeys.run(Date.now(), guildId);
}

function getNotesChannelId(guildId) {
    const row = stmts.getGuild.get(guildId);
    return row?.notes_channel_id || null;
}

function setNotesChannelId(guildId, channelId) {
    const now = Date.now();
    stmts.setChannelId.run(guildId, channelId, now, now);
}

function recordSession({
    guildId,
    channelId = null,
    channelName = null,
    startedAt,
    endedAt,
    durationSeconds = 0,
    participantCount = 0,
    participants = '',
    summaryProvider = null,
    summaryModel = null,
    transcriptEntriesCount = 0,
    status,
    errorMessage = null,
}) {
    try {
        stmts.insertSession.run({
            guild_id: guildId,
            channel_id: channelId,
            channel_name: channelName,
            started_at: typeof startedAt === 'object' ? startedAt.toISOString() : String(startedAt),
            ended_at: typeof endedAt === 'object' ? endedAt.toISOString() : String(endedAt),
            duration_seconds: Math.round(durationSeconds),
            participant_count: participantCount,
            participants: typeof participants === 'object' ? JSON.stringify(participants) : String(participants),
            summary_provider: summaryProvider,
            summary_model: summaryModel,
            transcript_entries_count: transcriptEntriesCount,
            status,
            error_message: errorMessage,
            created_at: Date.now(),
        });
    } catch (err) {
        console.error('[database] Failed to record meeting session:', err);
    }
}

function getGuildStats(guildId) {
    return stmts.getGuildStats.get(guildId) || {
        total_meetings: 0,
        completed_meetings: 0,
        failed_meetings: 0,
        total_duration_seconds: 0,
    };
}

function getRecentSessions(guildId, limit = 5) {
    return stmts.getRecentSessions.all(guildId, limit);
}

function logApiRequest({ guildId, service, model = null, status, tokensUsed = 0, errorMessage = null }) {
    try {
        stmts.insertApiRequest.run({
            guild_id: guildId,
            service,
            model,
            status,
            tokens_used: tokensUsed,
            error_message: errorMessage,
            created_at: Date.now(),
        });
    } catch (err) {
        console.error('[database] Failed to log API request:', err);
    }
}

function getGuildRequestStats(guildId) {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const dailyStats = stmts.getDailyRequestStats.get(guildId, oneDayAgo) || {
        total_requests_24h: 0,
        stt_requests_24h: 0,
        summary_requests_24h: 0,
        rate_limit_hits_24h: 0,
    };

    const lifetimeStats = stmts.getLifetimeRequestStats.get(guildId) || {
        total_lifetime_requests: 0,
    };

    const config = getGuildConfig(guildId);
    const limit = config.dailyRequestLimit || 0;
    const remaining = limit > 0 ? Math.max(0, limit - dailyStats.total_requests_24h) : null;

    return {
        daily: dailyStats,
        lifetime: lifetimeStats,
        limit,
        remaining,
    };
}

function checkRequestQuota(guildId) {
    const config = getGuildConfig(guildId);
    const limit = config.dailyRequestLimit || 0;
    if (limit <= 0) return { allowed: true, remaining: null, limit: 0, used: 0 };

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const countRow = stmts.countRequestsSince.get(guildId, oneDayAgo);
    const used = countRow ? countRow.total : 0;
    const remaining = Math.max(0, limit - used);

    return {
        allowed: used < limit,
        remaining,
        limit,
        used,
    };
}

function setGuildQuota(guildId, limit) {
    const now = Date.now();
    stmts.setQuota.run(guildId, Math.max(0, parseInt(limit, 10) || 0), now, now);
}

module.exports = {
    db,
    getGuildConfig,
    setGuildKeys,
    clearGuildKeys,
    getNotesChannelId,
    setNotesChannelId,
    recordSession,
    getGuildStats,
    getRecentSessions,
    logApiRequest,
    getGuildRequestStats,
    checkRequestQuota,
    setGuildQuota,
};

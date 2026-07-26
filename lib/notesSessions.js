// One active transcription session per guild.
const sessions = new Map();

function createSession(guildId, data) {
    const session = {
        transcript: [],
        activeStreams: new Set(),
        pendingTranscriptions: new Set(), // in-flight finish() promises, awaited on stop
        ...data,
    };
    sessions.set(guildId, session);
    return session;
}

function getSession(guildId) {
    return sessions.get(guildId);
}

function endSession(guildId) {
    sessions.delete(guildId);
}

module.exports = { createSession, getSession, endSession };

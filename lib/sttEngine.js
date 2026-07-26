// Per-guild STT engine choice, set via `/notes model` before `/notes start`.
// Whisper (default) handles Hindi/English/Hinglish code-switching but is much
// slower on CPU; Vosk is fast but English-only (no code-switching support) —
// see the "Legacy (Vosk)" note in .env for why Whisper became the default.
const DEFAULT_CONFIG = { engine: 'whisper' };

const guildEngineConfigs = new Map();

function getEngineConfig(guildId) {
    return guildEngineConfigs.get(guildId) ?? DEFAULT_CONFIG;
}

function setEngineConfig(guildId, config) {
    guildEngineConfigs.set(guildId, config);
}

module.exports = { getEngineConfig, setEngineConfig };

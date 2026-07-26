const { getDefaultLanguage } = require('./voskService');

// Per-guild STT language override; falls back to DEFAULT_STT_LANGUAGE.
const guildLanguages = new Map();

function getLanguage(guildId) {
    return guildLanguages.get(guildId) ?? getDefaultLanguage();
}

function setLanguage(guildId, languageCode) {
    guildLanguages.set(guildId, languageCode);
}

module.exports = { getLanguage, setLanguage };

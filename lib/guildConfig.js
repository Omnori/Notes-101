const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '../guild_configs.json');
let guildConfigs = {};

function loadConfigs() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
            guildConfigs = JSON.parse(data);
        }
    } catch (error) {
        console.error('[guildConfig] Error loading guild_configs.json:', error);
        guildConfigs = {};
    }
}

function saveConfigs() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(guildConfigs, null, 2), 'utf-8');
    } catch (error) {
        console.error('[guildConfig] Error saving guild_configs.json:', error);
    }
}

loadConfigs();

function getGuildConfig(guildId) {
    return guildConfigs[guildId] || {};
}

function setGuildKeys(guildId, { groqApiKey, geminiApiKey, summaryProvider }) {
    if (!guildConfigs[guildId]) guildConfigs[guildId] = {};
    if (groqApiKey !== undefined) guildConfigs[guildId].groqApiKey = groqApiKey;
    if (geminiApiKey !== undefined) guildConfigs[guildId].geminiApiKey = geminiApiKey;
    if (summaryProvider !== undefined) guildConfigs[guildId].summaryProvider = summaryProvider;
    saveConfigs();
}

function clearGuildKeys(guildId) {
    if (guildConfigs[guildId]) {
        delete guildConfigs[guildId].groqApiKey;
        delete guildConfigs[guildId].geminiApiKey;
        delete guildConfigs[guildId].summaryProvider;
        if (Object.keys(guildConfigs[guildId]).length === 0) {
            delete guildConfigs[guildId];
        }
        saveConfigs();
    }
}

function getNotesChannelId(guildId) {
    return guildConfigs[guildId]?.notesChannelId || null;
}

function setNotesChannelId(guildId, channelId) {
    if (!guildConfigs[guildId]) guildConfigs[guildId] = {};
    guildConfigs[guildId].notesChannelId = channelId;
    saveConfigs();
}

module.exports = {
    getGuildConfig,
    setGuildKeys,
    clearGuildKeys,
    getNotesChannelId,
    setNotesChannelId,
};

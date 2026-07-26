// Per-guild override for which text channel /notes stop posts the finished
// notes to. In-memory only — resets on bot restart, same as lib/sttLanguage.js
// did. Falls back to wherever /notes stop was invoked if unset.
const guildChannels = new Map();

function getNotesChannelId(guildId) {
    return guildChannels.get(guildId) ?? null;
}

function setNotesChannelId(guildId, channelId) {
    guildChannels.set(guildId, channelId);
}

module.exports = { getNotesChannelId, setNotesChannelId };

// Per-guild override for which text channel /notes stop posts the finished
// notes to. In-memory only — resets on bot restart. Falls back to wherever
// /notes stop was invoked if unset.
const { getNotesChannelId, setNotesChannelId } = require('./guildConfig');

module.exports = { getNotesChannelId, setNotesChannelId };

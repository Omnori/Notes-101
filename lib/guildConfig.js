const database = require('./database');

module.exports = {
    getGuildConfig: database.getGuildConfig,
    setGuildKeys: database.setGuildKeys,
    clearGuildKeys: database.clearGuildKeys,
    getNotesChannelId: database.getNotesChannelId,
    setNotesChannelId: database.setNotesChannelId,
    recordSession: database.recordSession,
    getGuildStats: database.getGuildStats,
    getRecentSessions: database.getRecentSessions,
    logApiRequest: database.logApiRequest,
    getGuildRequestStats: database.getGuildRequestStats,
    checkRequestQuota: database.checkRequestQuota,
    setGuildQuota: database.setGuildQuota,
};

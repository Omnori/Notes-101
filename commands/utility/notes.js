const { pipeline } = require('node:stream/promises');
const {
    SlashCommandBuilder,
    MessageFlags,
    AttachmentBuilder,
    ChannelType,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const { joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus, entersState } = require('@discordjs/voice');

const { createSession, getSession, endSession } = require('../../lib/notesSessions');
const { transcribePcm16kMono: transcribeWithGroq, summarizeTranscriptWithGroq } = require('../../lib/groqService');
const {
    getGuildConfig,
    setGuildKeys,
    clearGuildKeys,
    setGuildNotionConfig,
    clearGuildNotionConfig,
    getNotesChannelId,
    setNotesChannelId,
    recordSession,
    getLatestCompletedSession,
    getGuildStats,
    getRecentSessions,
    logApiRequest,
    logAudit,
    getRecentAuditLogs,
} = require('../../lib/guildConfig');
const {
    normalizeNotionId,
    maskToken,
    validateWikiPageAccess,
    getWikiPageInfo,
    provisionWikiStructure,
    publishMeetingNotes,
    getNotionClient,
} = require('../../lib/notion');
const { syncOrgInfoForGuild, fetchOrgInfoContext } = require('../../lib/orgInfoSync');
const {
    syncMeetingTasksAndPersonalNotes,
    askGroundedAssistant,
    handleFollowUpInteraction,
} = require('../../lib/memberAssistant');
const { summarizeTranscript } = require('../../lib/geminiService');
const { Pcm48kStereoTo16kMono } = require('../../lib/pcmResampler');
const { ResilientOpusDecoder } = require('../../lib/opusDecoder');
const { sanitizeErrorMessage } = require('../../lib/safeError');

const MIN_UTTERANCE_BYTES = 16000; // ~0.5s of 16kHz mono 16-bit audio, filters out noise blips

function formatTimestamp(date) {
    return date.toTimeString().slice(0, 8);
}

function sanitizeForFilename(text) {
    return text.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function buildFilename(session) {
    const names = [...session.participants.values()].map(sanitizeForFilename).filter(Boolean);
    const namesPart = names.length ? names.join('-') : 'no-speakers';
    const date = session.startedAt.toISOString().slice(0, 10);
    const time = session.startedAt.toTimeString().slice(0, 5).replace(':', '');
    const filename = `notes_${namesPart}_${date}_${time}.md`;
    return filename.length > 200 ? `notes_${names.length}-people_${date}_${time}.md` : filename;
}

function buildNotesMarkdown(session, summary) {
    const date = session.startedAt.toLocaleDateString('en-CA'); // YYYY-MM-DD
    const startTime = session.startedAt.toTimeString().slice(0, 8);
    const endTime = new Date().toTimeString().slice(0, 8);
    const participants = [...session.participants.values()];

    return [
        `# Voice Notes — ${session.voiceChannelName}`,
        '',
        `- **Date:** ${date}`,
        `- **Time:** ${startTime} – ${endTime}`,
        `- **Participants:** ${participants.length ? participants.join(', ') : '_none captured_'}`,
        '',
        '---',
        '',
        summary,
        '',
    ].join('\n');
}

async function deliverOutput(interaction, guildId, payload) {
    const channelId = getNotesChannelId(guildId);
    if (!channelId || channelId === interaction.channelId) {
        await interaction.editReply(payload);
        return;
    }

    try {
        const channel = await interaction.guild.channels.fetch(channelId);
        await channel.send(payload);
        await interaction.editReply(`Posted in <#${channelId}>.`);
    } catch (error) {
        console.error(`[notes:${guildId}] failed to post to configured notes channel ${channelId}:`, error);
        await interaction.editReply({
            content: `Couldn't post to the configured notes channel (<#${channelId}>), posting here instead:\n${payload.content ?? ''}`,
            files: payload.files,
        });
    }
}

function captureUserUtterance(receiver, userId, session, guild) {
    if (session.activeStreams.has(userId)) return;
    session.activeStreams.add(userId);
    const timestamp = new Date();

    const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const decoder = new ResilientOpusDecoder({ rate: 48000, channels: 2, frameSize: 960 });
    const resampler = new Pcm48kStereoTo16kMono();
    const chunks = [];
    resampler.on('data', (chunk) => chunks.push(chunk));

    const finish = async () => {
        session.activeStreams.delete(userId);
        const pcm = Buffer.concat(chunks);
        if (pcm.length < MIN_UTTERANCE_BYTES) return;

        const model = process.env.GROQ_MODEL || 'whisper-large-v3-turbo';
        let text;
        try {
            text = await transcribeWithGroq(pcm, session.groqApiKey, guild.id);
            logApiRequest({
                guildId: guild.id,
                service: 'groq_stt',
                model,
                status: 'success',
            });
        } catch (error) {
            console.error(`[notes:${guild.id}] Groq STT transcription failed:`, error);
            const isRateLimit = String(error?.message || '').includes('429');
            logApiRequest({
                guildId: guild.id,
                service: 'groq_stt',
                model,
                status: isRateLimit ? 'rate_limited' : 'error',
                errorMessage: error?.message || String(error),
            });
            if (!session.sttErrors) session.sttErrors = [];
            const msg = error?.message || String(error);
            if (!session.sttErrors.includes(msg)) {
                session.sttErrors.push(msg);
            }
            return;
        }
        if (!text) return;

        const member = await guild.members.fetch(userId).catch(() => null);
        const speaker = member?.displayName ?? `<@${userId}>`;
        session.participants.set(userId, speaker);
        const entry = { speaker, text, timestamp };
        session.transcript.push(entry);
        console.log(`[notes:${guild.id}] ${formatTimestamp(entry.timestamp)} ${speaker}: ${text}`);
    };

    const settle = (runner) => {
        const promise = runner().catch((error) => {
            console.error(`[notes:${guild.id}] unexpected error finishing utterance for ${userId}:`, error);
        });
        session.pendingTranscriptions.add(promise);
        promise.finally(() => session.pendingTranscriptions.delete(promise));
    };

    settle(async () => {
        try {
            await pipeline(opusStream, decoder, resampler);
        } catch (error) {
            if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
                console.error(`[notes:${guild.id}] Audio pipeline error for ${userId}:`, error);
            }
        }
        await finish();
    });
}

async function startNotes(interaction) {
    const guildId = interaction.guildId;
    if (getSession(guildId)) {
        await interaction.reply({
            content: 'Already taking notes in this server. Use `/notes stop` first.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const guildConfig = getGuildConfig(guildId);
    const groqKey = guildConfig.groqApiKey || process.env.GROQ_API_KEY;

    if (!groqKey) {
        await interaction.reply({
            content: '**No Groq API Key set for this server.**\nA server admin must configure an API key first using `/notes setkey groq_key:<your_groq_api_key>`.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
        await interaction.reply({
            content: 'You need to be in a voice channel first!',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply();

    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
    });

    connection.on('stateChange', (oldState, newState) => {
        if (newState.status === VoiceConnectionStatus.Disconnected) {
            console.warn(`[notes:${guildId}] voice connection unexpectedly disconnected (was ${oldState.status})`);
        } else if (newState.status === VoiceConnectionStatus.Destroyed) {
            console.info(`[notes:${guildId}] voice connection destroyed, cleaning up session`);
            endSession(guildId);
        }
    });

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
        console.error(`[notes:${guildId}] voice connection never became Ready:`, error);
        connection.destroy();
        await interaction.editReply(
            `**Failed to connect to voice channel:** ${error.message || 'Connection timeout'}`,
        );
        return;
    }

    const providerOverride = interaction.options.getString('provider');
    const modelOverride = interaction.options.getString('model');

    const summaryProvider = providerOverride || guildConfig.summaryProvider || process.env.SUMMARY_PROVIDER || 'groq';
    const groqModel = (summaryProvider === 'groq' && modelOverride)
        ? modelOverride.trim()
        : (guildConfig.groqModel || process.env.GROQ_SUMMARY_MODEL || 'openai/gpt-oss-120b');
    const geminiModel = (summaryProvider === 'gemini' && modelOverride)
        ? modelOverride.trim()
        : (guildConfig.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash');

    const session = createSession(guildId, {
        connection,
        textChannelId: interaction.channelId,
        voiceChannelName: voiceChannel.name,
        startedAt: new Date(),
        participants: new Map(),
        groqApiKey: groqKey,
        geminiApiKey: guildConfig.geminiApiKey || process.env.GEMINI_API_KEY,
        summaryProvider,
        groqModel,
        geminiModel,
        sttErrors: [],
    });

    const receiver = connection.receiver;
    const onSpeakingStart = (userId) => captureUserUtterance(receiver, userId, session, voiceChannel.guild);
    receiver.speaking.on('start', onSpeakingStart);
    session.onSpeakingStart = onSpeakingStart;

    const modelName = process.env.GROQ_MODEL || 'whisper-large-v3-turbo';
    const activeSummaryModel = summaryProvider === 'gemini' ? geminiModel : groqModel;
    await interaction.editReply(
        `Joined **${voiceChannel.name}** and started taking notes (${modelName} STT | ${summaryProvider.toUpperCase()} \`${activeSummaryModel}\` Summary). Run \`/notes stop\` when done.`,
    );
}

const retryCache = new Map();
const RETRY_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const activeAskCollectors = new Map();

function cleanRetryCache() {
    const now = Date.now();
    for (const [id, item] of retryCache.entries()) {
        if (now - item.createdAt > RETRY_TTL_MS) {
            retryCache.delete(id);
        }
    }
}

async function summarizeTranscriptContent(transcriptText, { guildId, groqKey, geminiKey, provider, groqModel, geminiModel, orgContext = null }) {
    let effectiveOrgContext = orgContext;
    if (effectiveOrgContext === null && guildId) {
        try {
            const guildConfig = getGuildConfig(guildId);
            if (guildConfig.notionToken && guildConfig.orgInfoPageId) {
                effectiveOrgContext = await fetchOrgInfoContext(guildConfig.notionToken, guildConfig.orgInfoPageId);
                if (effectiveOrgContext) {
                    console.log(`[notes:${guildId}] Injected fresh Org Info context into summarization (${effectiveOrgContext.length} chars).`);
                }
            }
        } catch (err) {
            console.warn(`[notes:${guildId}] Non-fatal: Failed to fetch Org Info context for summarization:`, err.message);
            effectiveOrgContext = '';
        }
    }

    let summary;
    let totalTokens = 0;
    let lastError = null;

    if (provider === 'gemini' && geminiKey) {
        try {
            const res = await summarizeTranscript(transcriptText, geminiKey, geminiModel, effectiveOrgContext);
            summary = res.summary || res;
            totalTokens = res.totalTokens || 0;
            if (guildId) {
                logApiRequest({
                    guildId,
                    service: 'gemini_summary',
                    model: geminiModel,
                    status: 'success',
                    tokensUsed: totalTokens,
                });
            }
        } catch (error) {
            lastError = error;
            console.warn('[notes] Gemini summarization failed, trying Groq fallback:', error);
            if (guildId) {
                const isRateLimit = String(error?.message || '').includes('429');
                logApiRequest({
                    guildId,
                    service: 'gemini_summary',
                    model: geminiModel,
                    status: isRateLimit ? 'rate_limited' : 'error',
                    errorMessage: error?.message || String(error),
                });
            }
            if (groqKey) {
                try {
                    const res = await summarizeTranscriptWithGroq(transcriptText, groqKey, groqModel, guildId, effectiveOrgContext);
                    summary = res.summary || res;
                    totalTokens = res.totalTokens || 0;
                    if (guildId) {
                        logApiRequest({
                            guildId,
                            service: 'groq_summary',
                            model: groqModel,
                            status: 'success',
                            tokensUsed: totalTokens,
                        });
                    }
                } catch (groqError) {
                    lastError = groqError;
                    console.error('All summarization attempts failed:', groqError);
                    if (guildId) {
                        const isRateLimit = String(groqError?.message || '').includes('429');
                        logApiRequest({
                            guildId,
                            service: 'groq_summary',
                            model: groqModel,
                            status: isRateLimit ? 'rate_limited' : 'error',
                            errorMessage: groqError?.message || String(groqError),
                        });
                    }
                }
            }
        }
    } else if (groqKey) {
        try {
            const res = await summarizeTranscriptWithGroq(transcriptText, groqKey, groqModel, guildId, effectiveOrgContext);
            summary = res.summary || res;
            totalTokens = res.totalTokens || 0;
            if (guildId) {
                logApiRequest({
                    guildId,
                    service: 'groq_summary',
                    model: groqModel,
                    status: 'success',
                    tokensUsed: totalTokens,
                });
            }
        } catch (error) {
            lastError = error;
            console.warn('[notes] Groq summarization failed, trying Gemini fallback:', error);
            if (guildId) {
                const isRateLimit = String(error?.message || '').includes('429');
                logApiRequest({
                    guildId,
                    service: 'groq_summary',
                    model: groqModel,
                    status: isRateLimit ? 'rate_limited' : 'error',
                    errorMessage: error?.message || String(error),
                });
            }
            if (geminiKey) {
                try {
                    const res = await summarizeTranscript(transcriptText, geminiKey, geminiModel, effectiveOrgContext);
                    summary = res.summary || res;
                    totalTokens = res.totalTokens || 0;
                    if (guildId) {
                        logApiRequest({
                            guildId,
                            service: 'gemini_summary',
                            model: geminiModel,
                            status: 'success',
                            tokensUsed: totalTokens,
                        });
                    }
                } catch (geminiError) {
                    lastError = geminiError;
                    console.error('All summarization attempts failed:', geminiError);
                    if (guildId) {
                        const isRateLimit = String(geminiError?.message || '').includes('429');
                        logApiRequest({
                            guildId,
                            service: 'gemini_summary',
                            model: geminiModel,
                            status: isRateLimit ? 'rate_limited' : 'error',
                            errorMessage: geminiError?.message || String(geminiError),
                        });
                    }
                }
            }
        }
    } else {
        lastError = new Error('No API key configured for summarization.');
    }

    return { summary, totalTokens, lastError };
}

async function stopNotes(interaction) {
    const guildId = interaction.guildId;
    const session = getSession(guildId);
    if (!session) {
        await interaction.reply({
            content: 'No notes session is running in this server.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply();

    session.connection.receiver.speaking.removeListener('start', session.onSpeakingStart);
    session.connection.destroy();
    endSession(guildId);

    if (session.pendingTranscriptions.size > 0) {
        const count = session.pendingTranscriptions.size;
        await interaction.editReply(
            `Stopping... waiting for ${count} in-flight transcription${count > 1 ? 's' : ''} to complete...`,
        );
        await Promise.allSettled([...session.pendingTranscriptions]);
    }

    if (session.transcript.length === 0) {
        recordSession({
            guildId,
            channelId: session.textChannelId,
            channelName: session.voiceChannelName,
            startedAt: session.startedAt,
            endedAt: new Date(),
            durationSeconds: (Date.now() - session.startedAt.getTime()) / 1000,
            participantCount: session.participants.size,
            participants: [...session.participants.values()],
            summaryProvider: session.summaryProvider,
            summaryModel: session.summaryProvider === 'gemini' ? session.geminiModel : session.groqModel,
            transcriptEntriesCount: 0,
            status: 'empty',
            errorMessage: session.sttErrors?.join('; ') || null,
        });
        let msg = 'Stopped. No speech was captured, so there are no notes to summarize.';
        if (session.sttErrors && session.sttErrors.length > 0) {
            msg += `\n\n**Speech-to-Text Errors Encountered:**\n${session.sttErrors.map((e) => `- ${e}`).join('\n')}`;
        }
        await interaction.editReply(msg);
        return;
    }

    session.transcript.sort((a, b) => a.timestamp - b.timestamp);
    const transcriptText = session.transcript
        .map((entry) => `[${formatTimestamp(entry.timestamp)}] ${entry.speaker}: ${entry.text}`)
        .join('\n');

    const groqKey = session.groqApiKey;
    const geminiKey = session.geminiApiKey;
    const provider = session.summaryProvider || 'groq';
    const groqModel = session.groqModel;
    const geminiModel = session.geminiModel;

    const { summary, lastError } = await summarizeTranscriptContent(transcriptText, {
        guildId,
        groqKey,
        geminiKey,
        provider,
        groqModel,
        geminiModel,
    });

    if (!summary) {
        cleanRetryCache();
        const failureReason = lastError?.message || 'Unknown error occurred during API summarization.';
        recordSession({
            guildId,
            channelId: session.textChannelId,
            channelName: session.voiceChannelName,
            startedAt: session.startedAt,
            endedAt: new Date(),
            durationSeconds: (Date.now() - session.startedAt.getTime()) / 1000,
            participantCount: session.participants.size,
            participants: [...session.participants.values()],
            summaryProvider: provider,
            summaryModel: provider === 'gemini' ? geminiModel : groqModel,
            transcriptEntriesCount: session.transcript.length,
            status: 'failed',
            errorMessage: failureReason,
        });

        const retryId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        retryCache.set(retryId, {
            guildId,
            sessionInfo: {
                voiceChannelName: session.voiceChannelName,
                startedAt: session.startedAt,
                participants: new Map(session.participants),
                groqApiKey: groqKey,
                geminiApiKey: geminiKey,
                summaryProvider: provider,
                groqModel,
                geminiModel,
            },
            transcriptText,
            createdAt: Date.now(),
        });

        const retryRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`retry_notes:${retryId}`)
                .setLabel('Retry Summarization')
                .setStyle(ButtonStyle.Primary),
        );

        const transcriptFile = new AttachmentBuilder(Buffer.from(transcriptText, 'utf-8'), { name: 'transcript.txt' });
        await deliverOutput(interaction, guildId, {
            content: `**Summarization Failed:** ${failureReason}\nHere is the raw transcript:`,
            files: [transcriptFile],
            components: [retryRow],
        });
        return;
    }

    recordSession({
        guildId,
        channelId: session.textChannelId,
        channelName: session.voiceChannelName,
        startedAt: session.startedAt,
        endedAt: new Date(),
        durationSeconds: (Date.now() - session.startedAt.getTime()) / 1000,
        participantCount: session.participants.size,
        participants: [...session.participants.values()],
        summaryProvider: provider,
        summaryModel: provider === 'gemini' ? geminiModel : groqModel,
        transcriptEntriesCount: session.transcript.length,
        status: 'completed',
        summaryText: summary,
    });

    const notesMarkdown = buildNotesMarkdown(session, summary);
    const notesFile = new AttachmentBuilder(Buffer.from(notesMarkdown, 'utf-8'), { name: buildFilename(session) });

    // Phase 3: Non-fatal publishing to Notion Meetings database
    let notionOutput = '';
    const guildConfig = getGuildConfig(guildId);
    if (guildConfig.notionToken && guildConfig.meetingsDbId) {
        try {
            const notionRes = await publishMeetingNotes({
                token: guildConfig.notionToken,
                meetingsDbId: guildConfig.meetingsDbId,
                session,
                markdownContent: notesMarkdown,
            });
            if (notionRes.published && notionRes.url) {
                notionOutput = `\n- **Notion Wiki:** [Open Meeting Page in Notion](${notionRes.url})`;
            }
        } catch (err) {
            console.error(`[notes:${guildId}] Non-fatal failure publishing to Notion:`, err.message);
        }
    }

    // Phase 4: Org Info sync (Automatic or prompt for manual)
    let orgInfoOutput = '';
    if (guildConfig.notionToken && guildConfig.orgInfoPageId) {
        if (guildConfig.syncMode === 'automatic') {
            try {
                const syncRes = await syncOrgInfoForGuild({
                    guildId,
                    meetingNotes: notesMarkdown,
                    force: true,
                });
                if (syncRes.success && syncRes.applied > 0) {
                    orgInfoOutput = `\n- **Org Info:** 🔄 Auto-synced ${syncRes.applied} facts/decisions to Org Info.`;
                }
            } catch (err) {
                console.error(`[notes:${guildId}] Org Info auto-sync failed non-fatally:`, err.message);
            }
        } else {
            orgInfoOutput = '\n- **Org Info:** ⏸️ Sync mode is manual. Use `/notes sync` to sync facts into Org Info.';
        }
    }

    // Phase 6: Sync Action Items to Action Items DB & Personal Pages
    let taskSyncOutput = '';
    if (guildConfig.notionToken && (guildConfig.actionItemsDbId || guildConfig.membersDbId)) {
        try {
            const client = getNotionClient(guildConfig.notionToken);
            const taskSyncRes = await syncMeetingTasksAndPersonalNotes({
                client,
                actionItemsDbId: guildConfig.actionItemsDbId,
                membersDbId: guildConfig.membersDbId,
                meetingNotes: notesMarkdown,
                participants: session.participants,
                session,
            });
            if (taskSyncRes.tasksCreated > 0 || taskSyncRes.membersUpdated > 0) {
                taskSyncOutput = `\n- **Tasks & Personal Notes:** 📋 Synced ${taskSyncRes.tasksCreated} action item(s) to Action Items DB and updated ${taskSyncRes.membersUpdated} member page(s).`;
            }
        } catch (err) {
            console.error(`[notes:${guildId}] Non-fatal error syncing meeting tasks to personal notes:`, err.message);
        }
    }

    await deliverOutput(interaction, guildId, {
        content: `Notes are ready:${notionOutput}${orgInfoOutput}${taskSyncOutput}`,
        files: [notesFile],
    });
}

async function handleChannel(interaction) {
    const guildId = interaction.guildId;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
        await interaction.reply({
            content: 'You need the Manage Channels permission to configure the notes channel.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const channelOption = interaction.options.getChannel('channel');

    if (!channelOption) {
        const currentId = getNotesChannelId(guildId);
        await interaction.reply({
            content: currentId
                ? `Notes are currently posted to <#${currentId}>.`
                : 'No notes channel is set — notes post wherever `/notes stop` is run.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const permissions = channelOption.permissionsFor(interaction.guild.members.me);
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles];
    if (!permissions?.has(required)) {
        await interaction.reply({
            content: `I don't have permission to view/send messages/attach files in ${channelOption}. Fix that first.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    setNotesChannelId(guildId, channelOption.id);
    await interaction.reply(`Notes will now be posted to ${channelOption}.`);
}

function checkAdminPermission(interaction) {
    if (interaction.guild.ownerId === interaction.user.id) return true;
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

async function handleSetKey(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to configure API keys.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const groqKey = interaction.options.getString('groq_key');
    const geminiKey = interaction.options.getString('gemini_key');
    const provider = interaction.options.getString('provider');
    const groqModel = interaction.options.getString('groq_model');
    const geminiModel = interaction.options.getString('gemini_model');

    if (!groqKey && !geminiKey && !provider && !groqModel && !geminiModel) {
        return handleKeyInfo(interaction);
    }

    const updatePayload = {};
    if (groqKey) updatePayload.groqApiKey = groqKey.trim();
    if (geminiKey) updatePayload.geminiApiKey = geminiKey.trim();
    if (provider) updatePayload.summaryProvider = provider;
    if (groqModel) updatePayload.groqModel = groqModel.trim();
    if (geminiModel) updatePayload.geminiModel = geminiModel.trim();

    setGuildKeys(guildId, updatePayload);

    const config = getGuildConfig(guildId);
    const mask = (str) => (str ? `\`${str.slice(0, 4)}...${str.slice(-4)}\`` : '_not set_');

    await interaction.reply({
        content: `**Configuration updated for ${interaction.guild.name}!**\n` +
            `- **Groq API Key:** ${mask(config.groqApiKey)}\n` +
            `- **Gemini API Key:** ${mask(config.geminiApiKey)}\n` +
            `- **Summary Provider:** **${config.summaryProvider || 'groq'}**\n` +
            `- **Groq Summary Model:** \`${config.groqModel || process.env.GROQ_SUMMARY_MODEL || 'openai/gpt-oss-120b'}\`\n` +
            `- **Gemini Summary Model:** \`${config.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash'}\``,
        flags: MessageFlags.Ephemeral,
    });
}

async function handleSetModel(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to configure models.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const groqModel = interaction.options.getString('groq_model');
    const geminiModel = interaction.options.getString('gemini_model');

    if (!groqModel && !geminiModel) {
        return handleKeyInfo(interaction);
    }

    const updatePayload = {};
    if (groqModel) updatePayload.groqModel = groqModel.trim();
    if (geminiModel) updatePayload.geminiModel = geminiModel.trim();

    setGuildKeys(guildId, updatePayload);

    const config = getGuildConfig(guildId);
    await interaction.reply({
        content: `**Models updated for ${interaction.guild.name}!**\n` +
            `- **Groq Summary Model:** \`${config.groqModel || process.env.GROQ_SUMMARY_MODEL || 'openai/gpt-oss-120b'}\`\n` +
            `- **Gemini Summary Model:** \`${config.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash'}\``,
        flags: MessageFlags.Ephemeral,
    });
}

async function handleClearKey(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to configure API keys.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    clearGuildKeys(guildId);
    await interaction.reply({
        content: `API keys and model configurations removed for **${interaction.guild.name}**.`,
        flags: MessageFlags.Ephemeral,
    });
}

async function handleKeyInfo(interaction) {
    const guildId = interaction.guildId;
    const config = getGuildConfig(guildId);
    const mask = (str) => (str ? `\`${str.slice(0, 4)}...${str.slice(-4)}\`` : '_not set_');

    await interaction.reply({
        content: `**Configuration for ${interaction.guild.name}:**\n` +
            `- **Groq API Key:** ${mask(config.groqApiKey)}\n` +
            `- **Gemini API Key:** ${mask(config.geminiApiKey)}\n` +
            `- **Summary Provider:** **${config.summaryProvider || 'groq'}**\n` +
            `- **Groq Summary Model:** \`${config.groqModel || process.env.GROQ_SUMMARY_MODEL || 'openai/gpt-oss-120b'}\`\n` +
            `- **Gemini Summary Model:** \`${config.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash'}\``,
        flags: MessageFlags.Ephemeral,
    });
}

async function handleSetNotion(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to configure Notion integration.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const token = interaction.options.getString('token')?.trim();
    const wikiInput = interaction.options.getString('wiki')?.trim();

    if (!token || !wikiInput) {
        await interaction.reply({
            content: 'Both `token` and `wiki` parameters are required.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const normalizedId = normalizeNotionId(wikiInput);
    if (!normalizedId) {
        await interaction.reply({
            content: '⚠️ Invalid Notion page ID or URL format. Please provide a valid Notion page URL or 32-character Page ID.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Validate access to the wiki page via Notion API
    const validation = await validateWikiPageAccess(token, normalizedId);

    if (!validation.valid) {
        if (validation.isConnectionShareError) {
            await interaction.editReply({
                content: '⚠️ **Cannot access the specified Notion Wiki page.**\n\n' +
                    'Please ensure you have connected your Notion integration to this page:\n' +
                    '1. Open the wiki page in Notion\n' +
                    '2. Click **Share** (or `...` in the top-right corner)\n' +
                    '3. Go to **Connections** (or **Add connections**)\n' +
                    '4. Select your integration\n\n' +
                    'Once connected, run `/notes setnotion` again.',
            });
            return;
        }

        if (validation.isUnauthorized) {
            await interaction.editReply({
                content: '⚠️ **Invalid Notion API Token.**\n\n' +
                    'Please verify that your internal integration secret (usually starting with `ntn_` or `secret_`) ' +
                    'was copied correctly from [Notion Integrations](https://www.notion.so/my-integrations) and is still active.',
            });
            return;
        }

        await interaction.editReply({
            content: `⚠️ **Failed to connect to Notion:** ${validation.message || 'Unknown error'}\n\n` +
                'Please verify the page ID and ensure your Notion integration is added under page **Share → Connections**.',
        });
        return;
    }

    // Auto-provision or link children under the wiki page (Meetings, Org Info, Action Items)
    const existingConfig = getGuildConfig(guildId);
    let provision;
    try {
        provision = await provisionWikiStructure(token, validation.pageId, existingConfig);
    } catch (err) {
        console.error(`[notes:${guildId}] Failed to provision Notion wiki structure:`, err);
        await interaction.editReply({
            content: `⚠️ **Notion page verified, but auto-provisioning failed:** ${sanitizeErrorMessage(err)}\n` +
                'Please verify your integration has edit permissions and re-run `/notes setnotion`.',
        });
        return;
    }

    // Save { notionToken, wikiPageId, meetingsDbId, orgInfoPageId, actionItemsDbId, membersDbId } encrypted at rest
    setGuildNotionConfig(guildId, {
        notionToken: token,
        wikiPageId: validation.pageId,
        meetingsDbId: provision.meetingsDbId,
        orgInfoPageId: provision.orgInfoPageId,
        actionItemsDbId: provision.actionItemsDbId,
        membersDbId: provision.membersDbId,
    });

    const statusBadge = (isCreated) => (isCreated ? '✨ *Auto-created*' : '🔗 *Linked existing*');

    await interaction.editReply({
        content: `✅ **Notion Wiki Connected & Provisioned for ${interaction.guild.name}!**\n` +
            `- **Wiki Root:** **${validation.title}** (\`${validation.pageId}\`)\n` +
            `- **Notion Token:** ${maskToken(token)}\n\n` +
            `**Provisioned Entities:**\n` +
            `- 📅 **Meetings Database:** \`${provision.meetingsDbId}\` ${statusBadge(provision.created.meetings)}\n` +
            `- 🏢 **Org Info Page:** \`${provision.orgInfoPageId}\` ${statusBadge(provision.created.orgInfo)}\n` +
            `- ✅ **Action Items Database:** \`${provision.actionItemsDbId}\` ${statusBadge(provision.created.actionItems)}\n` +
            `- 👥 **Members Database:** \`${provision.membersDbId}\` ${statusBadge(provision.created.members)}`,
    });
}

async function handleNotionInfo(interaction) {
    const guildId = interaction.guildId;
    const config = getGuildConfig(guildId);

    if (!config.notionToken || !config.wikiPageId) {
        await interaction.reply({
            content: `**Notion Wiki Configuration for ${interaction.guild.name}:**\n` +
                `- **Status:** _Not configured_\n\n` +
                `Use \`/notes setnotion token:<token> wiki:<page_id>\` to connect your server's Notion wiki.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const check = await getWikiPageInfo(config.notionToken, config.wikiPageId);
    const formatStatus = (id) => (id ? '✅ Configured' : '⚪ Not configured');

    if (check.valid) {
        await interaction.editReply({
            content: `**Notion Wiki Configuration for ${interaction.guild.name}:**\n` +
                `- **Connection Status:** 🟢 Connected\n` +
                `- **Wiki Title:** **${check.title}**\n` +
                `- **Notion Token:** ${maskToken(config.notionToken)}\n\n` +
                `**Integration Entities:**\n` +
                `- 📅 **Meetings Database:** ${formatStatus(config.meetingsDbId)}\n` +
                `- 🏢 **Org Info Page:** ${formatStatus(config.orgInfoPageId)}\n` +
                `- ✅ **Action Items Database:** ${formatStatus(config.actionItemsDbId)}\n` +
                `- 👥 **Members Database:** ${formatStatus(config.membersDbId)}`,
        });
    } else {
        const safeErr = sanitizeErrorMessage(check.message || 'Access denied');
        await interaction.editReply({
            content: `**Notion Wiki Configuration for ${interaction.guild.name}:**\n` +
                `- **Connection Status:** 🔴 Connection Error (${safeErr})\n` +
                `- **Notion Token:** ${maskToken(config.notionToken)}\n\n` +
                `_Tip: Open the page in Notion → Share → Connections → ensure your integration is added._`,
        });
    }
}

async function handleNotionProvision(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to provision the Notion wiki.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const config = getGuildConfig(guildId);
    if (!config.notionToken || !config.wikiPageId) {
        await interaction.reply({
            content: 'Notion is not configured for this server yet. Use `/notes setnotion token:<token> wiki:<page_id>` first.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const provision = await provisionWikiStructure(config.notionToken, config.wikiPageId, config);

        setGuildNotionConfig(guildId, {
            notionToken: config.notionToken,
            wikiPageId: config.wikiPageId,
            meetingsDbId: provision.meetingsDbId,
            orgInfoPageId: provision.orgInfoPageId,
            actionItemsDbId: provision.actionItemsDbId,
            membersDbId: provision.membersDbId,
        });

        const statusBadge = (isCreated) => (isCreated ? '✨ *Auto-created*' : '🔗 *Linked existing*');

        await interaction.editReply({
            content: `**Notion Wiki Provisioning for ${interaction.guild.name}:**\n\n` +
                `**Entities:**\n` +
                `- 📅 **Meetings Database:** ${statusBadge(provision.created.meetings)}\n` +
                `- 🏢 **Org Info Page:** ${statusBadge(provision.created.orgInfo)}\n` +
                `- ✅ **Action Items Database:** ${statusBadge(provision.created.actionItems)}\n` +
                `- 👥 **Members Database:** ${statusBadge(provision.created.members)}`,
        });
    } catch (err) {
        console.error(`[notes:${guildId}] Notion provisioning failed:`, err);
        await interaction.editReply({
            content: `⚠️ **Provisioning failed:** ${sanitizeErrorMessage(err)}`,
        });
    }
}

async function handleClearNotion(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to configure Notion integration.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    clearGuildNotionConfig(guildId);

    // Cancel any active ask collectors for this guild
    for (const [key, collector] of activeAskCollectors.entries()) {
        if (key.startsWith(`${guildId}:`)) {
            try {
                collector.stop('guild_cleared');
            } catch {
                // Ignore collector stop error
            }
            activeAskCollectors.delete(key);
        }
    }

    await interaction.reply({
        content: `Notion integration and wiki configurations removed for **${interaction.guild.name}**.`,
        flags: MessageFlags.Ephemeral,
    });
}

async function handleSyncMode(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to change Notion sync mode.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const mode = interaction.options.getString('mode');
    setGuildNotionConfig(guildId, { syncMode: mode });

    const modeDesc = mode === 'automatic'
        ? '🤖 **Automatic**: Meeting notes will automatically extract and patch facts/decisions into Org Info upon `/notes stop`.'
        : '✋ **Manual**: Automatic updates are paused. Use `/notes sync` whenever you want to sync meeting facts into Org Info.';

    await interaction.reply({
        content: `**Notion Sync Mode Updated for ${interaction.guild.name}:**\n` +
            `- **Active Mode:** \`${mode}\`\n\n` +
            `${modeDesc}`,
        flags: MessageFlags.Ephemeral,
    });
}

async function handleSync(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to run Org Info sync.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const config = getGuildConfig(guildId);
    if (!config.notionToken || !config.orgInfoPageId) {
        await interaction.reply({
            content: 'Notion is not configured for this server. Use `/notes setnotion token:<token> wiki:<page_id>` first.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    let notesText = interaction.options.getString('notes')?.trim();

    if (!notesText) {
        const latestSession = getLatestCompletedSession(guildId);
        if (latestSession && latestSession.summary_text) {
            notesText = latestSession.summary_text;
        }
    }

    if (!notesText) {
        await interaction.reply({
            content: 'No recent meeting notes found in the database. Run a voice meeting with `/notes start` and `/notes stop` first, or provide notes directly via `/notes sync notes:<text>`.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const syncRes = await syncOrgInfoForGuild({
            guildId,
            meetingNotes: notesText,
            force: true,
        });

        if (!syncRes.success) {
            await interaction.editReply({
                content: `⚠️ **Sync could not proceed:** ${syncRes.reason || 'Unknown reason'}`,
            });
            return;
        }

        if (syncRes.applied === 0) {
            await interaction.editReply({
                content: `ℹ️ **Org Info Synchronized:** No new organizational facts, ongoing projects, or decisions required updating from the latest notes.`,
            });
            return;
        }

        const patchDetails = syncRes.patches.map((p) => {
            const badge = p.action === 'update' ? '🔄 [UPDATE]' : '➕ [ADD]';
            return `• ${badge} **${p.section}**: ${p.content}`;
        }).join('\n');

        await interaction.editReply({
            content: `✅ **Org Info Synchronized for ${interaction.guild.name}!**\n` +
                `- **Facts Added:** ${syncRes.addedCount}\n` +
                `- **Facts Updated:** ${syncRes.updatedCount}\n\n` +
                `**Applied Block Patches:**\n${patchDetails}`,
        });
    } catch (err) {
        console.error(`[notes:${guildId}] Org Info sync failed:`, err);
        await interaction.editReply({
            content: `⚠️ **Org Info sync encountered an error:** ${sanitizeErrorMessage(err)}`,
        });
    }
}

async function handleAsk(interaction) {
    const guildId = interaction.guildId;
    const config = getGuildConfig(guildId);

    if (!config.notionToken || !config.wikiPageId) {
        await interaction.reply({
            content: '⚠️ Notion is not configured for this server yet. An administrator must configure it with `/notes setnotion` first.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const question = interaction.options.getString('question')?.trim();
    if (!question) {
        await interaction.reply({
            content: 'Please provide a question to ask.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const targetUserOption = interaction.options.getUser('member');
    let targetMember = interaction.user;

    // Strict user-scoped resolution:
    if (targetUserOption && targetUserOption.id !== interaction.user.id) {
        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
                        interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
                        interaction.guild?.ownerId === interaction.user.id;
        if (!isAdmin) {
            await interaction.reply({
                content: '⛔ **Access Denied:** Only administrators can query another member\'s personal records and tasks. You can run `/notes ask` without specifying a member to query your own tasks and general wiki info.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        targetMember = targetUserOption;
    }

    await interaction.deferReply();

    try {
        let orgInfoText = '';
        if (config.orgInfoPageId) {
            try {
                orgInfoText = await fetchOrgInfoContext(config.notionToken, config.orgInfoPageId);
            } catch (err) {
                console.warn(`[notes:ask] Warning fetching org context:`, err.message);
            }
        }

        const recentMeetings = getRecentSessions(guildId, 5);
        const groqKey = config.groqApiKey || process.env.GROQ_API_KEY;
        const geminiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
        const provider = config.summaryProvider || process.env.SUMMARY_PROVIDER || 'groq';
        const groqModel = config.groqModel || process.env.GROQ_SUMMARY_MODEL || 'openai/gpt-oss-120b';
        const geminiModel = config.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash';

        const qRes = await askGroundedAssistant({
            question,
            callerUser: interaction.user,
            targetMember,
            guildConfig: config,
            recentMeetings,
            orgInfoText,
            provider,
            apiKey: provider === 'gemini' ? geminiKey : groqKey,
            model: provider === 'gemini' ? geminiModel : groqModel,
            guildId,
        });

        logAudit({
            guildId,
            userId: interaction.user.id,
            userTag: interaction.user.tag || interaction.user.username,
            action: 'ask_query',
            targetMemberId: targetMember.id,
            details: question,
        });

        const targetNote = targetMember.id !== interaction.user.id
            ? ` *(Target Member: <@${targetMember.id}>)*`
            : '';

        const replyContent = `**Question:** "${question}"${targetNote}\n\n${qRes.answer}\n\n` +
            `*💬 **Conversation Active (2 mins):** Reply in this channel to ask follow-up questions or update tasks/notes (e.g. \`mark task ... as done\` or \`add note: ...\`). Type \`done\` to close.*`;

        await interaction.editReply({
            content: replyContent,
        });

        // Start short-lived 2-minute message collector with frozen authorization context
        if (interaction.channel) {
            const authContext = {
                guildId,
                channelId: interaction.channelId,
                actingUserId: interaction.user.id,
                targetDiscordUserId: targetMember.id,
                targetMember,
                sessionId: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
            };

            const collectorKey = `${guildId}:${interaction.user.id}:${interaction.channelId}`;
            if (activeAskCollectors.has(collectorKey)) {
                try {
                    activeAskCollectors.get(collectorKey).stop('superseded');
                } catch {
                    // Ignore error stopping previous collector
                }
                activeAskCollectors.delete(collectorKey);
            }

            const isAdmin = checkAdminPermission(interaction);
            const filter = (m) => m.author.id === interaction.user.id && !m.author.bot;
            const collector = interaction.channel.createMessageCollector({
                filter,
                time: 120000, // 2 minutes
            });
            activeAskCollectors.set(collectorKey, collector);

            collector.on('end', () => {
                if (activeAskCollectors.get(collectorKey) === collector) {
                    activeAskCollectors.delete(collectorKey);
                }
            });

            collector.on('collect', async (userMsg) => {
                try {
                    await userMsg.channel.sendTyping().catch(() => {});
                    // Strictly pass the frozen targetMember and original callerUser:
                    // Natural-language follow-ups cannot switch targets or elevate permissions
                    const followUpRes = await handleFollowUpInteraction({
                        userMessage: userMsg.content,
                        callerUser: interaction.user,
                        targetMember: authContext.targetMember,
                        guildConfig: config,
                        recentMeetings,
                        orgInfoText,
                        provider,
                        apiKey: provider === 'gemini' ? geminiKey : groqKey,
                        model: provider === 'gemini' ? geminiModel : groqModel,
                        guildId,
                        isAdmin,
                    });

                    await userMsg.reply({
                        content: followUpRes.message,
                    });

                    if (followUpRes.type === 'exit') {
                        collector.stop('user_exit');
                    }
                } catch (fuErr) {
                    console.error('[notes:collector] Error processing follow-up:', fuErr);
                    await userMsg.reply({
                        content: `⚠️ Failed to process follow-up: ${sanitizeErrorMessage(fuErr)}`,
                    }).catch(() => {});
                }
            });
        }
    } catch (err) {
        console.error(`[notes:ask] Error handling question:`, err);
        await interaction.editReply({
            content: `⚠️ **Assistant encountered an error:** ${sanitizeErrorMessage(err)}`,
        });
    }
}

async function handleAudit(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to view audit logs.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const logs = getRecentAuditLogs(guildId, 15);
    if (!logs || logs.length === 0) {
        await interaction.reply({
            content: `No audit log entries recorded yet for **${interaction.guild.name}**.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const rows = logs.map((l) => {
        const timeStr = new Date(l.created_at).toLocaleString('en-US', { timeZone: 'UTC' });
        const targetStr = l.target_member_id ? ` (Target: <@${l.target_member_id}>)` : '';
        let detailStr = l.details || '';
        if (detailStr.length > 80) detailStr = detailStr.slice(0, 77) + '...';
        return `• \`[${timeStr} UTC]\` <@${l.user_id}>: **${l.action}**${targetStr}\n  _${detailStr}_`;
    }).join('\n');

    await interaction.reply({
        content: `📋 **Recent Assistant & Notion Audit Logs for ${interaction.guild.name} (Last ${logs.length}):**\n\n${rows}`,
        flags: MessageFlags.Ephemeral,
    });
}

async function handleButton(interaction) {
    if (!interaction.customId?.startsWith('retry_notes:')) return;
    const retryId = interaction.customId.slice('retry_notes:'.length);
    const entry = retryCache.get(retryId);
    if (!entry) {
        await interaction.reply({
            content: 'This retry session has expired or the bot was restarted. Please refer to the raw transcript attached above.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    // Strict cross-guild isolation check
    if (entry.guildId !== interaction.guildId) {
        await interaction.reply({
            content: '⛔ **Access Denied:** You cannot trigger a retry for a session from another server.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply();

    const { guildId, sessionInfo, transcriptText } = entry;
    const guildConfig = getGuildConfig(guildId);

    const groqKey = guildConfig.groqApiKey || sessionInfo.groqApiKey || process.env.GROQ_API_KEY;
    const geminiKey = guildConfig.geminiApiKey || sessionInfo.geminiApiKey || process.env.GEMINI_API_KEY;
    const provider = guildConfig.summaryProvider || sessionInfo.summaryProvider || process.env.SUMMARY_PROVIDER || 'groq';
    const groqModel = guildConfig.groqModel || sessionInfo.groqModel || process.env.GROQ_SUMMARY_MODEL || 'openai/gpt-oss-120b';
    const geminiModel = guildConfig.geminiModel || sessionInfo.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash';

    const { summary, lastError } = await summarizeTranscriptContent(transcriptText, {
        guildId,
        groqKey,
        geminiKey,
        provider,
        groqModel,
        geminiModel,
    });

    if (!summary) {
        const failureReason = lastError?.message || 'Unknown error occurred during API summarization.';
        const retryRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`retry_notes:${retryId}`)
                .setLabel('Retry Summarization')
                .setStyle(ButtonStyle.Primary),
        );
        await interaction.editReply({
            content: `**Retry Failed:** ${failureReason}\nYou can update your configuration via \`/notes setmodel\` and click retry again:`,
            components: [retryRow],
        });
        return;
    }

    // Disable the button on the previous message if possible
    const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`retried_${retryId}`)
            .setLabel('Retried Successfully')
            .setStyle(ButtonStyle.Success)
            .setDisabled(true),
    );
    await interaction.message?.edit({ components: [disabledRow] }).catch(() => {});

    // Deliver the finalized notes
    const effectiveSession = {
        ...sessionInfo,
        startedAt: sessionInfo.startedAt instanceof Date ? sessionInfo.startedAt : new Date(sessionInfo.startedAt),
    };

    recordSession({
        guildId,
        channelId: interaction.channelId,
        channelName: sessionInfo.voiceChannelName,
        startedAt: effectiveSession.startedAt,
        endedAt: new Date(),
        durationSeconds: (Date.now() - effectiveSession.startedAt.getTime()) / 1000,
        participantCount: sessionInfo.participants?.size || 0,
        participants: sessionInfo.participants ? [...sessionInfo.participants.values()] : [],
        summaryProvider: provider,
        summaryModel: provider === 'gemini' ? geminiModel : groqModel,
        transcriptEntriesCount: transcriptText.split('\n').filter(Boolean).length,
        status: 'completed',
    });

    const notesMarkdown = buildNotesMarkdown(effectiveSession, summary);
    const notesFile = new AttachmentBuilder(Buffer.from(notesMarkdown, 'utf-8'), { name: buildFilename(effectiveSession) });

    // Non-fatal publishing to Notion Meetings database on retry
    let notionOutput = '';
    if (guildConfig.notionToken && guildConfig.meetingsDbId) {
        try {
            const notionRes = await publishMeetingNotes({
                token: guildConfig.notionToken,
                meetingsDbId: guildConfig.meetingsDbId,
                session: effectiveSession,
                markdownContent: notesMarkdown,
            });
            if (notionRes.published && notionRes.url) {
                notionOutput = `\n- **Notion Wiki:** [Open Meeting Page in Notion](${notionRes.url})`;
            }
        } catch (err) {
            console.error(`[notes:${guildId}] Non-fatal retry publishing to Notion:`, err.message);
        }
    }

    let taskSyncOutput = '';
    if (guildConfig.notionToken && (guildConfig.actionItemsDbId || guildConfig.membersDbId)) {
        try {
            const client = getNotionClient(guildConfig.notionToken);
            const taskSyncRes = await syncMeetingTasksAndPersonalNotes({
                client,
                actionItemsDbId: guildConfig.actionItemsDbId,
                membersDbId: guildConfig.membersDbId,
                meetingNotes: notesMarkdown,
                participants: effectiveSession.participants,
                session: effectiveSession,
            });
            if (taskSyncRes.tasksCreated > 0 || taskSyncRes.membersUpdated > 0) {
                taskSyncOutput = `\n- **Tasks & Personal Notes:** 📋 Synced ${taskSyncRes.tasksCreated} action item(s) to Action Items DB and updated ${taskSyncRes.membersUpdated} member page(s).`;
            }
        } catch (err) {
            console.error(`[notes:${guildId}] Non-fatal retry syncing tasks to personal notes:`, err.message);
        }
    }

    await deliverOutput(interaction, guildId, {
        content: `**Notes successfully summarized on retry:**${notionOutput}${taskSyncOutput}`,
        files: [notesFile],
    });
}

async function handleStats(interaction) {
    const guildId = interaction.guildId;
    const stats = getGuildStats(guildId);
    const recent = getRecentSessions(guildId, 5);

    const totalHours = Math.floor((stats.total_duration_seconds || 0) / 3600);
    const totalMinutes = Math.floor(((stats.total_duration_seconds || 0) % 3600) / 60);
    const timeFormatted = totalHours > 0 ? `${totalHours}h ${totalMinutes}m` : `${totalMinutes}m`;

    let recentText = '_No meetings recorded yet._';
    if (recent && recent.length > 0) {
        recentText = recent
            .map((r) => {
                const date = r.started_at ? r.started_at.slice(0, 10) : 'unknown';
                const statusLabel = r.status === 'completed' ? '[Completed]' : r.status === 'failed' ? '[Failed]' : '[Empty]';
                const durMin = Math.round((r.duration_seconds || 0) / 60);
                return `${statusLabel} **${date}** in *${r.channel_name || 'voice'}* (${durMin}m, ${r.participant_count} speakers)`;
            })
            .join('\n');
    }

    await interaction.reply({
        content: `**Voice Notes Stats for ${interaction.guild.name}:**\n` +
            `- **Total Meetings Recorded:** ${stats.total_meetings || 0}\n` +
            `- **Successful Summaries:** ${stats.completed_meetings || 0}\n` +
            `- **Failed / Incomplete:** ${stats.failed_meetings || 0}\n` +
            `- **Total Meeting Time:** ${timeFormatted}\n\n` +
            `**Recent Meetings:**\n${recentText}`,
        flags: MessageFlags.Ephemeral,
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('notes')
        .setDescription('Voice-channel note taking (Powered by Groq & Gemini)')
        .addSubcommand((sub) =>
            sub
                .setName('start')
                .setDescription('Join your voice channel and start taking notes')
                .addStringOption((opt) =>
                    opt
                        .setName('provider')
                        .setDescription('Override summary AI provider for this session')
                        .setRequired(false)
                        .addChoices({ name: 'Groq', value: 'groq' }, { name: 'Gemini', value: 'gemini' }),
                )
                .addStringOption((opt) =>
                    opt
                        .setName('model')
                        .setDescription('Override summary model code name (e.g. openai/gpt-oss-120b, gemini-2.5-flash)')
                        .setRequired(false),
                ),
        )
        .addSubcommand((sub) => sub.setName('stop').setDescription('Stop taking notes and post a summary'))
        .addSubcommand((sub) =>
            sub
                .setName('channel')
                .setDescription('View or set the channel notes get posted to')
                .addChannelOption((opt) =>
                    opt
                        .setName('channel')
                        .setDescription('Text channel to post notes in (omit to view current)')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(false),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('setkey')
                .setDescription('Set Groq / Gemini API key and models for this server (Admins only)')
                .addStringOption((opt) =>
                    opt.setName('groq_key').setDescription('Groq API Key (used for voice STT and Groq summaries)').setRequired(false),
                )
                .addStringOption((opt) =>
                    opt.setName('gemini_key').setDescription('Gemini API Key (optional for Gemini summaries)').setRequired(false),
                )
                .addStringOption((opt) =>
                    opt
                        .setName('provider')
                        .setDescription('Preferred summary AI provider')
                        .setRequired(false)
                        .addChoices({ name: 'Groq', value: 'groq' }, { name: 'Gemini', value: 'gemini' }),
                )
                .addStringOption((opt) =>
                    opt
                        .setName('groq_model')
                        .setDescription('Groq summary model code name (e.g. openai/gpt-oss-120b, openai/gpt-oss-20b)')
                        .setRequired(false),
                )
                .addStringOption((opt) =>
                    opt
                        .setName('gemini_model')
                        .setDescription('Gemini summary model code name (e.g. gemini-2.5-flash, gemini-1.5-pro)')
                        .setRequired(false),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('setmodel')
                .setDescription('Set summary AI model code names for Groq or Gemini (Admins only)')
                .addStringOption((opt) =>
                    opt
                        .setName('groq_model')
                        .setDescription('Groq summary model code name (e.g. openai/gpt-oss-120b, openai/gpt-oss-20b)')
                        .setRequired(false),
                )
                .addStringOption((opt) =>
                    opt
                        .setName('gemini_model')
                        .setDescription('Gemini summary model code name (e.g. gemini-2.5-flash, gemini-1.5-pro)')
                        .setRequired(false),
                ),
        )
        .addSubcommand((sub) => sub.setName('clearkey').setDescription('Clear API keys and model configurations for this server'))
        .addSubcommand((sub) => sub.setName('keyinfo').setDescription('View API keys and model configuration for this server'))
        .addSubcommand((sub) => sub.setName('stats').setDescription('View voice notes stats and meeting history for this server'))
        .addSubcommand((sub) =>
            sub
                .setName('setnotion')
                .setDescription('Connect server to a Notion Wiki page (Admins only)')
                .addStringOption((opt) =>
                    opt
                        .setName('token')
                        .setDescription('Notion internal integration secret (starts with ntn_ or secret_)')
                        .setRequired(true),
                )
                .addStringOption((opt) =>
                    opt
                        .setName('wiki')
                        .setDescription('Notion Wiki root page URL or Page ID')
                        .setRequired(true),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('notioninfo')
                .setDescription('View Notion wiki connection status and page details for this server'),
        )
        .addSubcommand((sub) =>
            sub
                .setName('clearnotion')
                .setDescription('Disconnect and clear Notion wiki configuration for this server (Admins only)'),
        )
        .addSubcommand((sub) =>
            sub
                .setName('notionprovision')
                .setDescription('Verify or re-provision wiki databases and pages (Meetings, Org Info, Action Items) (Admins only)'),
        )
        .addSubcommand((sub) =>
            sub
                .setName('syncmode')
                .setDescription('Toggle Org Info sync mode between automatic and manual (Admins only)')
                .addStringOption((opt) =>
                    opt
                        .setName('mode')
                        .setDescription('Sync mode: automatic or manual')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Automatic (Sync after every meeting)', value: 'automatic' },
                            { name: 'Manual (Sync via /notes sync only)', value: 'manual' },
                        ),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('sync')
                .setDescription('Extract and sync facts/decisions from the latest meeting into Org Info (Admins only)')
                .addStringOption((opt) =>
                    opt
                        .setName('notes')
                        .setDescription('Optional specific notes text to sync (omit to use latest meeting)')
                        .setRequired(false),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('ask')
                .setDescription('Ask questions grounded in the server wiki, meeting notes, and personal tasks')
                .addStringOption((opt) =>
                    opt
                        .setName('question')
                        .setDescription('Your question about projects, decisions, meetings, or tasks')
                        .setRequired(true),
                )
                .addUserOption((opt) =>
                    opt
                        .setName('member')
                        .setDescription('Admin only: query another member personal notes and tasks')
                        .setRequired(false),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('audit')
                .setDescription('View recent assistant Q&A and Notion update audit logs (Admins only)')
                .addIntegerOption((opt) =>
                    opt
                        .setName('limit')
                        .setDescription('Number of logs to view (default: 10, max: 25)')
                        .setRequired(false),
                ),
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'start') return startNotes(interaction);
        if (sub === 'stop') return stopNotes(interaction);
        if (sub === 'channel') return handleChannel(interaction);
        if (sub === 'setkey') return handleSetKey(interaction);
        if (sub === 'setmodel') return handleSetModel(interaction);
        if (sub === 'clearkey') return handleClearKey(interaction);
        if (sub === 'keyinfo') return handleKeyInfo(interaction);
        if (sub === 'stats') return handleStats(interaction);
        if (sub === 'setnotion') return handleSetNotion(interaction);
        if (sub === 'notioninfo') return handleNotionInfo(interaction);
        if (sub === 'clearnotion') return handleClearNotion(interaction);
        if (sub === 'notionprovision') return handleNotionProvision(interaction);
        if (sub === 'syncmode') return handleSyncMode(interaction);
        if (sub === 'sync') return handleSync(interaction);
        if (sub === 'ask') return handleAsk(interaction);
        if (sub === 'audit') return handleAudit(interaction);
    },
    handleButton,
};


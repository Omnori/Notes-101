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
    getNotesChannelId,
    setNotesChannelId,
    recordSession,
    getGuildStats,
    getRecentSessions,
    logApiRequest,
    getGuildRequestStats,
    checkRequestQuota,
    setGuildQuota,
} = require('../../lib/guildConfig');
const { summarizeTranscript } = require('../../lib/geminiService');
const { Pcm48kStereoTo16kMono } = require('../../lib/pcmResampler');
const { ResilientOpusDecoder } = require('../../lib/opusDecoder');

const MIN_UTTERANCE_BYTES = 3200; // ~0.1s of 16kHz mono 16-bit audio, filters out noise blips

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
        end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
    });
    const decoder = new ResilientOpusDecoder({ rate: 48000, channels: 2, frameSize: 960 });
    const resampler = new Pcm48kStereoTo16kMono();
    const chunks = [];
    resampler.on('data', (chunk) => chunks.push(chunk));

    const finish = async () => {
        session.activeStreams.delete(userId);
        const pcm = Buffer.concat(chunks);
        if (pcm.length < MIN_UTTERANCE_BYTES) return;

        const quota = checkRequestQuota(guild.id);
        if (!quota.allowed) {
            console.warn(`[notes:${guild.id}] Daily API request limit reached (${quota.used}/${quota.limit})`);
            if (!session.sttErrors) session.sttErrors = [];
            const msg = `Daily API request limit reached (${quota.used}/${quota.limit}). Upgrade or adjust via /notes setquota.`;
            if (!session.sttErrors.includes(msg)) session.sttErrors.push(msg);
            return;
        }

        const model = process.env.GROQ_MODEL || 'whisper-large-v3-turbo';
        let text;
        try {
            text = await transcribeWithGroq(pcm, session.groqApiKey);
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
            content: '❌ **No Groq API Key set for this server.**\nA server admin must configure an API key first using `/notes setkey groq_key:<your_groq_api_key>`.',
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
            `❌ **Failed to connect to voice channel:** ${error.message || 'Connection timeout'}`,
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

function cleanRetryCache() {
    const now = Date.now();
    for (const [id, item] of retryCache.entries()) {
        if (now - item.createdAt > RETRY_TTL_MS) {
            retryCache.delete(id);
        }
    }
}

async function summarizeTranscriptContent(transcriptText, { guildId, groqKey, geminiKey, provider, groqModel, geminiModel }) {
    let summary;
    let lastError = null;

    if (provider === 'gemini' && geminiKey) {
        try {
            summary = await summarizeTranscript(transcriptText, geminiKey, geminiModel);
            if (guildId) {
                logApiRequest({
                    guildId,
                    service: 'gemini_summary',
                    model: geminiModel,
                    status: 'success',
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
                    summary = await summarizeTranscriptWithGroq(transcriptText, groqKey, groqModel);
                    if (guildId) {
                        logApiRequest({
                            guildId,
                            service: 'groq_summary',
                            model: groqModel,
                            status: 'success',
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
            summary = await summarizeTranscriptWithGroq(transcriptText, groqKey, groqModel);
            if (guildId) {
                logApiRequest({
                    guildId,
                    service: 'groq_summary',
                    model: groqModel,
                    status: 'success',
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
                    summary = await summarizeTranscript(transcriptText, geminiKey, geminiModel);
                    if (guildId) {
                        logApiRequest({
                            guildId,
                            service: 'gemini_summary',
                            model: geminiModel,
                            status: 'success',
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

    return { summary, lastError };
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
            msg += `\n\n❌ **Speech-to-Text Errors Encountered:**\n${session.sttErrors.map((e) => `- ${e}`).join('\n')}`;
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
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🔄'),
        );

        const transcriptFile = new AttachmentBuilder(Buffer.from(transcriptText, 'utf-8'), { name: 'transcript.txt' });
        await deliverOutput(interaction, guildId, {
            content: `⚠️ **Summarization Failed:** ${failureReason}\nHere is the raw transcript:`,
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
    });

    const notesMarkdown = buildNotesMarkdown(session, summary);
    const notesFile = new AttachmentBuilder(Buffer.from(notesMarkdown, 'utf-8'), { name: buildFilename(session) });
    await deliverOutput(interaction, guildId, { content: 'Notes are ready:', files: [notesFile] });
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
        content: `✅ **Configuration updated for ${interaction.guild.name}!**\n` +
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
        content: `✅ **Models updated for ${interaction.guild.name}!**\n` +
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
        content: `🗑️ API keys and model configurations removed for **${interaction.guild.name}**.`,
        flags: MessageFlags.Ephemeral,
    });
}

async function handleKeyInfo(interaction) {
    const guildId = interaction.guildId;
    const config = getGuildConfig(guildId);
    const mask = (str) => (str ? `\`${str.slice(0, 4)}...${str.slice(-4)}\`` : '_not set_');

    await interaction.reply({
        content: `🔑 **Configuration for ${interaction.guild.name}:**\n` +
            `- **Groq API Key:** ${mask(config.groqApiKey)}\n` +
            `- **Gemini API Key:** ${mask(config.geminiApiKey)}\n` +
            `- **Summary Provider:** **${config.summaryProvider || 'groq'}**\n` +
            `- **Groq Summary Model:** \`${config.groqModel || process.env.GROQ_SUMMARY_MODEL || 'openai/gpt-oss-120b'}\`\n` +
            `- **Gemini Summary Model:** \`${config.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash'}\``,
        flags: MessageFlags.Ephemeral,
    });
}

async function handleButton(interaction) {
    if (!interaction.customId?.startsWith('retry_notes:')) return;
    const retryId = interaction.customId.slice('retry_notes:'.length);
    const entry = retryCache.get(retryId);
    if (!entry) {
        await interaction.reply({
            content: '⚠️ This retry session has expired or the bot was restarted. Please refer to the raw transcript attached above.',
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
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🔄'),
        );
        await interaction.editReply({
            content: `⚠️ **Retry Failed:** ${failureReason}\nYou can update your configuration via \`/notes setmodel\` and click retry again:`,
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
            .setDisabled(true)
            .setEmoji('✅'),
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
    await deliverOutput(interaction, guildId, {
        content: '✅ **Notes successfully summarized on retry:**',
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
                const statusEmoji = r.status === 'completed' ? '✅' : r.status === 'failed' ? '❌' : '⚠️';
                const durMin = Math.round((r.duration_seconds || 0) / 60);
                return `${statusEmoji} **${date}** in *${r.channel_name || 'voice'}* (${durMin}m, ${r.participant_count} speakers)`;
            })
            .join('\n');
    }

    await interaction.reply({
        content: `📊 **Voice Notes Stats for ${interaction.guild.name}:**\n` +
            `- **Total Meetings Recorded:** ${stats.total_meetings || 0}\n` +
            `- **Successful Summaries:** ${stats.completed_meetings || 0}\n` +
            `- **Failed / Incomplete:** ${stats.failed_meetings || 0}\n` +
            `- **Total Meeting Time:** ${timeFormatted}\n\n` +
            `**Recent Meetings:**\n${recentText}`,
        flags: MessageFlags.Ephemeral,
    });
}

async function handleRequests(interaction) {
    const guildId = interaction.guildId;
    const stats = getGuildRequestStats(guildId);
    const { daily, lifetime, limit, remaining } = stats;

    const limitStr = limit > 0 ? `${limit} requests/day` : 'Unlimited (no cap)';
    const remainingStr = limit > 0 ? `${remaining} remaining today` : 'Unlimited';

    await interaction.reply({
        content: `📡 **API Request & Quota Stats for ${interaction.guild.name}:**\n` +
            `- **24h Total Requests:** ${daily.total_requests_24h || 0}\n` +
            `  • Speech-to-Text (STT): ${daily.stt_requests_24h || 0}\n` +
            `  • Summarization: ${daily.summary_requests_24h || 0}\n` +
            `- **Rate Limit (429) Hits (24h):** ${daily.rate_limit_hits_24h || 0}\n` +
            `- **Lifetime API Requests:** ${lifetime.total_lifetime_requests || 0}\n` +
            `- **Daily Quota Limit:** ${limitStr}\n` +
            `- **Remaining Today:** ${remainingStr}\n\n` +
            `_Admins can adjust the daily cap using \`/notes setquota\`._`,
        flags: MessageFlags.Ephemeral,
    });
}

async function handleSetQuota(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to configure request quotas.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const limit = interaction.options.getInteger('limit');
    if (limit === null || limit === undefined || limit < 0) {
        await interaction.reply({
            content: 'Please specify a valid non-negative integer for the quota limit (0 for unlimited).',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    setGuildQuota(guildId, limit);

    await interaction.reply({
        content: limit > 0
            ? `✅ Daily API request quota for **${interaction.guild.name}** set to **${limit} requests/day**.`
            : `✅ Daily API request quota for **${interaction.guild.name}** is now **unlimited** (cap removed).`,
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
        .addSubcommand((sub) => sub.setName('requests').setDescription('View API request usage and quota stats for this server'))
        .addSubcommand((sub) =>
            sub
                .setName('setquota')
                .setDescription('Set daily API request quota limit for this server (0 = unlimited, Admins only)')
                .addIntegerOption((opt) =>
                    opt
                        .setName('limit')
                        .setDescription('Maximum API requests allowed per 24 hours (0 for unlimited)')
                        .setRequired(true)
                        .setMinValue(0),
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
        if (sub === 'requests') return handleRequests(interaction);
        if (sub === 'setquota') return handleSetQuota(interaction);
    },
    handleButton,
};


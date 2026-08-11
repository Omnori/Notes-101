const { pipeline } = require('node:stream/promises');
const { SlashCommandBuilder, MessageFlags, AttachmentBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus, entersState } = require('@discordjs/voice');

const { createSession, getSession, endSession } = require('../../lib/notesSessions');
const { transcribePcm16kMono: transcribeWithGroq, summarizeTranscriptWithGroq } = require('../../lib/groqService');
const { getGuildConfig, setGuildKeys, clearGuildKeys, getNotesChannelId, setNotesChannelId } = require('../../lib/guildConfig');
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

        let text;
        try {
            text = await transcribeWithGroq(pcm, session.groqApiKey);
        } catch (error) {
            console.error(`[notes:${guild.id}] Groq STT transcription failed:`, error);
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

    const session = createSession(guildId, {
        connection,
        textChannelId: interaction.channelId,
        voiceChannelName: voiceChannel.name,
        startedAt: new Date(),
        participants: new Map(),
        groqApiKey: groqKey,
        geminiApiKey: guildConfig.geminiApiKey || process.env.GEMINI_API_KEY,
        summaryProvider: guildConfig.summaryProvider || process.env.SUMMARY_PROVIDER || 'groq',
        sttErrors: [],
    });

    const receiver = connection.receiver;
    const onSpeakingStart = (userId) => captureUserUtterance(receiver, userId, session, voiceChannel.guild);
    receiver.speaking.on('start', onSpeakingStart);
    session.onSpeakingStart = onSpeakingStart;

    const modelName = process.env.GROQ_MODEL || 'whisper-large-v3-turbo';
    await interaction.editReply(
        `Joined **${voiceChannel.name}** and started taking notes using server API key (${modelName}). Run \`/notes stop\` when done.`,
    );
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

    let summary;
    let lastError = null;
    const groqKey = session.groqApiKey;
    const geminiKey = session.geminiApiKey;
    const provider = session.summaryProvider || 'groq';

    if (provider === 'gemini' && geminiKey) {
        try {
            summary = await summarizeTranscript(transcriptText, geminiKey);
        } catch (error) {
            lastError = error;
            console.warn('[notes] Gemini summarization failed, trying Groq fallback:', error);
            if (groqKey) {
                try {
                    summary = await summarizeTranscriptWithGroq(transcriptText, groqKey);
                } catch (groqError) {
                    lastError = groqError;
                    console.error('All summarization attempts failed:', groqError);
                }
            }
        }
    } else if (groqKey) {
        try {
            summary = await summarizeTranscriptWithGroq(transcriptText, groqKey);
        } catch (error) {
            lastError = error;
            console.warn('[notes] Groq summarization failed, trying Gemini fallback:', error);
            if (geminiKey) {
                try {
                    summary = await summarizeTranscript(transcriptText, geminiKey);
                } catch (geminiError) {
                    lastError = geminiError;
                    console.error('All summarization attempts failed:', geminiError);
                }
            }
        }
    } else {
        lastError = new Error('No API key configured for summarization.');
    }

    if (!summary) {
        const failureReason = lastError?.message || 'Unknown error occurred during API summarization.';
        const transcriptFile = new AttachmentBuilder(Buffer.from(transcriptText, 'utf-8'), { name: 'transcript.txt' });
        await deliverOutput(interaction, guildId, {
            content: `⚠️ **Summarization Failed:** ${failureReason}\nHere is the raw transcript:`,
            files: [transcriptFile],
        });
        return;
    }

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

    if (!groqKey && !geminiKey && !provider) {
        return handleKeyInfo(interaction);
    }

    const updatePayload = {};
    if (groqKey) updatePayload.groqApiKey = groqKey;
    if (geminiKey) updatePayload.geminiApiKey = geminiKey;
    if (provider) updatePayload.summaryProvider = provider;

    setGuildKeys(guildId, updatePayload);

    const config = getGuildConfig(guildId);
    const mask = (str) => (str ? `\`${str.slice(0, 4)}...${str.slice(-4)}\`` : '_not set_');

    await interaction.reply({
        content: `✅ **API keys updated for ${interaction.guild.name}!**\n` +
            `- **Groq API Key:** ${mask(config.groqApiKey)}\n` +
            `- **Gemini API Key:** ${mask(config.geminiApiKey)}\n` +
            `- **Summary Provider:** **${config.summaryProvider || 'groq'}**`,
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
        content: `🗑️ API keys removed for **${interaction.guild.name}**.`,
        flags: MessageFlags.Ephemeral,
    });
}

async function handleKeyInfo(interaction) {
    const guildId = interaction.guildId;
    const config = getGuildConfig(guildId);
    const mask = (str) => (str ? `\`${str.slice(0, 4)}...${str.slice(-4)}\`` : '_not set_');

    await interaction.reply({
        content: `🔑 **API Key Configuration for ${interaction.guild.name}:**\n` +
            `- **Groq API Key:** ${mask(config.groqApiKey)}\n` +
            `- **Gemini API Key:** ${mask(config.geminiApiKey)}\n` +
            `- **Summary Provider:** **${config.summaryProvider || 'groq'}**`,
        flags: MessageFlags.Ephemeral,
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('notes')
        .setDescription('Voice-channel note taking (Powered by user Groq & Gemini API keys)')
        .addSubcommand((sub) => sub.setName('start').setDescription('Join your voice channel and start taking notes'))
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
                .setDescription('Set Groq / Gemini API key for this server (Admins only)')
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
                        .addChoices({ name: 'Groq (Llama 3.3 70B)', value: 'groq' }, { name: 'Gemini', value: 'gemini' }),
                ),
        )
        .addSubcommand((sub) => sub.setName('clearkey').setDescription('Clear API keys configured for this server'))
        .addSubcommand((sub) => sub.setName('keyinfo').setDescription('View API key status for this server')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'start') return startNotes(interaction);
        if (sub === 'stop') return stopNotes(interaction);
        if (sub === 'channel') return handleChannel(interaction);
        if (sub === 'setkey') return handleSetKey(interaction);
        if (sub === 'clearkey') return handleClearKey(interaction);
        if (sub === 'keyinfo') return handleKeyInfo(interaction);
    },
};


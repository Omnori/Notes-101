const { pipeline } = require('node:stream/promises');
const { SlashCommandBuilder, MessageFlags, AttachmentBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus, entersState } = require('@discordjs/voice');

const { createSession, getSession, endSession } = require('../../lib/notesSessions');
const { getContext, transcribePcm16kMono: transcribeWithWhisper } = require('../../lib/whisperService');
const { getModel: getVoskModel, transcribePcm16kMono: transcribeWithVosk } = require('../../lib/voskService');
const { getEngineConfig, setEngineConfig } = require('../../lib/sttEngine');
const { getNotesChannelId, setNotesChannelId } = require('../../lib/notesChannel');
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
    // Keep well under Discord's attachment filename limits even with many participants.
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

// Posts the final notes/fallback-transcript payload to the guild's configured
// notes channel (if any and different from where /notes stop was run), or just
// replies in-place otherwise. Always exactly one outgoing message either way.
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
    // Captured at speaking-start, not after recording/transcription finish — both of those can lag
    // well behind the moment the user actually started talking (silence-end padding, and whisper.cpp
    // transcription time on top of that), which would drift the displayed timestamp.
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

        const { engine, language } = session.engineConfig;
        let text;
        try {
            text = engine === 'vosk' ? transcribeWithVosk(pcm, language) : await transcribeWithWhisper(pcm);
        } catch (error) {
            console.error(`[notes:${guild.id}] ${engine} transcription failed:`, error);
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

    // Track each utterance's processing promise so /notes stop can wait for
    // in-flight transcriptions instead of guessing a fixed delay — CPU-only
    // whisper.cpp on modest hardware can take several times the audio's own
    // duration to transcribe a single long utterance.
    const settle = (runner) => {
        const promise = runner().catch((error) => {
            console.error(`[notes:${guild.id}] unexpected error finishing utterance for ${userId}:`, error);
        });
        session.pendingTranscriptions.add(promise);
        promise.finally(() => session.pendingTranscriptions.delete(promise));
    };

    // `.pipe().pipe()` does NOT forward 'error' events between the piped streams — a decode
    // error on `decoder` would go unhandled and crash the whole process. stream/promises'
    // pipeline() correctly propagates errors from any stage and tears down the whole chain.
    settle(async () => {
        try {
            await pipeline(opusStream, decoder, resampler);
        } catch (error) {
            // Expected whenever the stream is cut off before ending naturally — e.g. `/notes stop`
            // destroying the connection mid-utterance, or the speaker leaving voice. Not a bug; just
            // transcribe whatever was captured up to that point.
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

    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
        await interaction.reply({
            content: 'You need to be in a voice channel first!',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply();

    const engineConfig = getEngineConfig(guildId);
    try {
        // Fail fast if the chosen engine's model is missing/invalid; also warms it up.
        if (engineConfig.engine === 'vosk') {
            getVoskModel(engineConfig.language);
        } else {
            await getContext();
        }
    } catch (error) {
        await interaction.editReply(`Can't start notes: ${error.message}`);
        return;
    }

    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false, // must hear audio to transcribe it
    });

    connection.on('stateChange', (oldState, newState) => {
        if (newState.status === VoiceConnectionStatus.Disconnected) {
            console.warn(`[notes:${guildId}] voice connection unexpectedly disconnected (was ${oldState.status})`);
        }
    });

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
        console.error(`[notes:${guildId}] voice connection never became Ready:`, error);
        connection.destroy();
        await interaction.editReply(
            "Joined the voice channel signaling-wise, but the audio (UDP) connection never became ready, " +
            'so I won\'t be able to hear anything. This is usually a network/firewall issue on the host ' +
            "running the bot.",
        );
        return;
    }

    const session = createSession(guildId, {
        connection,
        textChannelId: interaction.channelId,
        voiceChannelName: voiceChannel.name,
        startedAt: new Date(),
        participants: new Map(), // userId -> displayName
        engineConfig, // locked in for the session so a mid-session `/notes model` change can't affect it
    });

    const receiver = connection.receiver;
    const onSpeakingStart = (userId) => captureUserUtterance(receiver, userId, session, voiceChannel.guild);
    receiver.speaking.on('start', onSpeakingStart);
    session.onSpeakingStart = onSpeakingStart;

    const engineLabel = engineConfig.engine === 'vosk' ? `Vosk (${engineConfig.language})` : 'Whisper';
    await interaction.editReply(
        `Joined **${voiceChannel.name}** and started taking notes with **${engineLabel}**. Run \`/notes stop\` when you're done.`,
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
            `Stopping... waiting for ${count} in-progress transcription${count > 1 ? 's' : ''} to finish ` +
            '(can take a while on this CPU for longer utterances).',
        );
        await Promise.allSettled([...session.pendingTranscriptions]);
    }

    if (session.transcript.length === 0) {
        await interaction.editReply('Stopped. No speech was captured, so there are no notes to summarize.');
        return;
    }

    session.transcript.sort((a, b) => a.timestamp - b.timestamp);
    const transcriptText = session.transcript
        .map((entry) => `[${formatTimestamp(entry.timestamp)}] ${entry.speaker}: ${entry.text}`)
        .join('\n');

    let summary;
    try {
        summary = await summarizeTranscript(transcriptText);
    } catch (error) {
        console.error('Gemini summarization failed:', error);
        const transcriptFile = new AttachmentBuilder(Buffer.from(transcriptText, 'utf-8'), { name: 'transcript.txt' });
        await deliverOutput(interaction, guildId, {
            content: 'Stopped taking notes. Summarization failed, but here is the raw transcript:',
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
                : "No notes channel is set — notes post wherever `/notes stop` is run.",
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

async function handleModel(interaction) {
    const guildId = interaction.guildId;
    if (getSession(guildId)) {
        await interaction.reply({
            content: "Can't switch models while a notes session is running. Use `/notes stop` first.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const choice = interaction.options.getString('engine');
    if (!choice) {
        const current = getEngineConfig(guildId);
        const label = current.engine === 'vosk' ? `Vosk (${current.language})` : 'Whisper (Hindi/English/Hinglish)';
        await interaction.reply({ content: `Current STT model: **${label}**.`, flags: MessageFlags.Ephemeral });
        return;
    }

    if (choice === 'whisper') {
        setEngineConfig(guildId, { engine: 'whisper' });
        await interaction.reply('STT model set to **Whisper** (Hindi/English/Hinglish, slower on this CPU).');
        return;
    }

    const language = choice.slice('vosk:'.length);
    try {
        getVoskModel(language); // fail fast if VOSK_MODELS isn't configured for this language
    } catch (error) {
        await interaction.reply({ content: `Can't switch to that Vosk model: ${error.message}`, flags: MessageFlags.Ephemeral });
        return;
    }
    setEngineConfig(guildId, { engine: 'vosk', language });
    await interaction.reply(
        `STT model set to **Vosk (${language})** — much faster, but English-only (no Hindi/Hinglish code-switching).`,
    );
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('notes')
        .setDescription('Voice-channel note taking (Hindi/English/Hinglish)')
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
                .setName('model')
                .setDescription('View or set the STT engine used by `/notes start` (must be set before joining)')
                .addStringOption((opt) =>
                    opt
                        .setName('engine')
                        .setDescription('STT engine to use (omit to view current)')
                        .setRequired(false)
                        .addChoices(
                            { name: 'Whisper — Hindi/English/Hinglish, slower on CPU', value: 'whisper' },
                            { name: 'Vosk — English (US), fast', value: 'vosk:en' },
                            { name: 'Vosk — English (India), fast', value: 'vosk:en-in' },
                        ),
                ),
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'start') return startNotes(interaction);
        if (sub === 'stop') return stopNotes(interaction);
        if (sub === 'model') return handleModel(interaction);
        return handleChannel(interaction);
    },
};

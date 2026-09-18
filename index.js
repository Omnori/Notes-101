require('dotenv').config({ quiet: true });

// Require the necessary discord.js classes
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, Events, GatewayIntentBits, MessageFlags } = require('discord.js');
const { sanitizeErrorMessage } = require('./lib/safeError');
let token = process.env.DISCORD_TOKEN;
if (!token) {
    try {
        const config = require('./config.json');
        token = config.token;
    } catch {
        // config.json missing or doesn't contain token
    }
}

if (!token) {
    console.error('Error: DISCORD_TOKEN is not set in environment or config.json.');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.once(Events.ClientReady, (readyClient) => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
});

// Log in to Discord with your client's token
client.login(token);


client.commands = new Collection();
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);
for (const folder of commandFolders) {
    const commandsPath = path.join(foldersPath, folder);
    const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));
    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        // Set a new item in the Collection with the key as the command name and the value as the exported module
        if ('data' in command && 'execute' in command) {
            client.commands.set(command.data.name, command);
        } else {
            console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
    }
}
client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
        const command = interaction.client.commands.get(interaction.commandName);

        if (!command) {
            console.error(`No command matching ${interaction.commandName} was found.`);
            return;
        }

        try {
            await command.execute(interaction);
        } catch (error) {
            console.error(`[InteractionError:${interaction.commandName}]`, error);
            const errorDetail = sanitizeErrorMessage(error);
            const userMessage = `**Error executing /${interaction.commandName}:** ${errorDetail}`.slice(0, 1950);

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: userMessage, flags: MessageFlags.Ephemeral }).catch(() => {});
            } else {
                await interaction.reply({ content: userMessage, flags: MessageFlags.Ephemeral }).catch(() => {});
            }
        }
        return;
    }

    if (interaction.isButton()) {
        if (interaction.customId.startsWith('retry_notes:')) {
            const command = interaction.client.commands.get('notes');
            if (command && typeof command.handleButton === 'function') {
                try {
                    await command.handleButton(interaction);
                } catch (error) {
                    console.error('[ButtonError:retry_notes]', error);
                    const errorDetail = sanitizeErrorMessage(error);
                    const userMessage = `**Retry error:** ${errorDetail}`.slice(0, 1950);
                    if (interaction.replied || interaction.deferred) {
                        await interaction.followUp({ content: userMessage, flags: MessageFlags.Ephemeral }).catch(() => {});
                    } else {
                        await interaction.reply({ content: userMessage, flags: MessageFlags.Ephemeral }).catch(() => {});
                    }
                }
            }
        }
    }
});

const { runGroundedAssistant } = require('./lib/assistantEngine');
const { sendSafeMessageReply } = require('./lib/discordUtils');
const { getGuildConfig } = require('./lib/guildConfig');

client.on(Events.MessageCreate, async (message) => {
    // Ignore bot messages or direct messages
    if (message.author.bot || !message.guildId) return;

    // Check if the bot was mentioned
    if (message.mentions.has(client.user.id)) {
        const guildId = message.guildId;
        const config = getGuildConfig(guildId);

        // Check if Notion integration is set up
        if (!config.notionToken || !config.wikiPageId) {
            return message.reply('Notion Integration is not configured for this server. Run `/notion setup` first.');
        }

        // Clean the message content to remove the bot mention
        const mentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
        const cleanMessage = message.content.replace(mentionRegex, '').trim();

        if (!cleanMessage) {
            return message.reply('Yes? How can I help you? Ask me a question about the server wiki, e.g., "@Soren what is our PTO policy?".');
        }

        try {
            // Trigger typing indicator
            await message.channel.sendTyping();

            // Run grounded assistant chat
            const answer = await runGroundedAssistant(guildId, message.author.id, [
                { role: 'user', content: cleanMessage },
            ]);

            await sendSafeMessageReply(message, answer, { fileName: 'soren_reply.md' });
        } catch (err) {
            console.error('[messageCreateEvent] Grounded assistant mention error:', err);
            await message.reply(`Sorry, I encountered an error: ${err.message}`);
        }
    }
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Promise Rejection:', reason);
});
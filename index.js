require('dotenv').config({ quiet: true });

// Require the necessary discord.js classes
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, Events, GatewayIntentBits, MessageFlags } = require('discord.js');
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
            const errorDetail = error?.message || String(error);
            const userMessage = `**Error executing /${interaction.commandName}:** ${errorDetail}`;

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
                    const errorDetail = error?.message || String(error);
                    const userMessage = `**Retry error:** ${errorDetail}`;
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

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Promise Rejection:', reason);
});
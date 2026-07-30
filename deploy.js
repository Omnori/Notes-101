const { REST, Routes } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

require('dotenv').config({ quiet: true });

let clientId = process.env.DISCORD_CLIENT_ID || process.env.CID;
let guildId = process.env.DISCORD_GUILD_ID;
let token = process.env.DISCORD_TOKEN;

try {
    const config = require('./config.json');
    clientId = clientId || config.clientId;
    guildId = guildId || config.guildId;
    token = token || config.token;
} catch {
    // config.json not present
}

if (!token || !clientId) {
    console.error('Error: DISCORD_TOKEN and DISCORD_CLIENT_ID (or CID) are required to deploy commands.');
    process.exit(1);
}

const commands = [];
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);
for (const folder of commandFolders) {
    const commandsPath = path.join(foldersPath, folder);
    const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));
    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        if ('data' in command && 'execute' in command) {
            commands.push(command.data.toJSON());
        } else {
            console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
    }
}

const rest = new REST().setToken(token);

(async () => {
    try {
        console.log(`Started refreshing ${commands.length} application (/) commands.`);
        const route = guildId
            ? Routes.applicationGuildCommands(clientId, guildId)
            : Routes.applicationCommands(clientId);
        const data = await rest.put(route, { body: commands });
        console.log(`Successfully reloaded ${data.length} application (/) commands.`);
    } catch (error) {
        console.error(error);
    }
})();
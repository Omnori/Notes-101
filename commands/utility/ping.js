const { SlashCommandBuilder } = require('discord.js');
module.exports = {
    data: new SlashCommandBuilder().setName('ping').setDescription('Replies with Pong!'),
    async execute(interaction) {
        await interaction.reply({
            content: 'Hello ' + interaction.user.globalName + ` Account ID ${interaction.user.username}`,
            files: [`https://cdn.discordapp.com/avatars/${interaction.user.id}/${interaction.user.avatar}.webp`]
        })
    },
};
const { SlashCommandBuilder } = require('discord.js');
module.exports = {
    data: new SlashCommandBuilder().setName('ping').setDescription('Replies with Pong!'),
    async execute(interaction) {
        const avatarUrl = interaction.user.displayAvatarURL({ extension: 'webp' });
        const displayName = interaction.user.globalName || interaction.user.username;
        await interaction.reply({
            content: `Pong! Hello ${displayName} (Username: ${interaction.user.username})`,
            files: [avatarUrl],
        });
    },
};
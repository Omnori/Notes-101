const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getVoiceConnection } = require('@discordjs/voice');
const { getSession } = require('../../lib/notesSessions');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Leaves the current voice channel'),
    async execute(interaction) {
        const guildId = interaction.guildId;

        if (getSession(guildId)) {
            await interaction.reply({
                content: 'A notes session is running. Use `/notes stop` to end it and leave.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const connection = getVoiceConnection(guildId);
        if (!connection) {
            await interaction.reply({ content: "I'm not in a voice channel.", flags: MessageFlags.Ephemeral });
            return;
        }

        connection.destroy();
        await interaction.reply('Left the voice channel.');
    },
};

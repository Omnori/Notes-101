const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('join')
        .setDescription('Joins the voice channel you are currently in'),
    async execute(interaction) {
        const voiceChannel = interaction.member.voice.channel;

        if (!voiceChannel) {
            await interaction.reply({
                content: 'You need to be in a voice channel for me to join!',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.deferReply();

        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        });

        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
            await interaction.editReply(`Joined **${voiceChannel.name}**!`);
        } catch {
            connection.destroy();
            await interaction.editReply(`Failed to join **${voiceChannel.name}**: connection timed out or failed.`);
        }
    },
};

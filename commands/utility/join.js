const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { joinVoiceChannel } = require('@discordjs/voice');

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

        joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        });

        await interaction.reply(`Joined **${voiceChannel.name}**!`);
    },
};

const { SlashCommandBuilder } = require('discord.js');
const { runGroundedAssistant } = require('../../lib/assistantEngine');
const { sendSafeChunkedReply } = require('../../lib/discordUtils');
const { getGuildConfig } = require('../../lib/guildConfig');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ask')
        .setDescription('Ask the grounded company assistant a question about wiki docs, tasks, or policies')
        .addStringOption((option) =>
            option
                .setName('question')
                .setDescription('The question you want to ask')
                .setRequired(true)
        ),
    async execute(interaction) {
        const guildId = interaction.guildId;
        if (!guildId) {
            return interaction.reply({
                content: 'This command can only be used within a Discord server.',
                flags: [64], // Ephemeral
            });
        }

        const config = getGuildConfig(guildId);
        if (!config.notionToken || !config.wikiPageId) {
            return interaction.reply({
                content: 'Notion Integration has not been fully set up for this server yet.\nAn admin can set it up using `/notion setup`.',
                flags: [64], // Ephemeral
            });
        }

        // Defer reply because LLM and Notion API queries can take a few seconds
        await interaction.deferReply();

        const question = interaction.options.getString('question');
        const userId = interaction.user.id;

        try {
            // Run grounded assistant chat
            const answer = await runGroundedAssistant(guildId, userId, [
                { role: 'user', content: question },
            ]);

            await sendSafeChunkedReply(interaction, answer, { fileName: 'soren_answer.md' });
        } catch (err) {
            console.error('[askCommand] Error running grounded assistant:', err);
            await interaction.editReply({
                content: `Sorry, I encountered an error while processing your request:\n\`\`\`\n${err.message}\n\`\`\``,
            });
        }
    },
};

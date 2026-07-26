const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('restart')
        .setDescription("Restarts the bot's process (admin only)")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        // setDefaultMemberPermissions only sets the default in Discord's UI; a server
        // admin can loosen it per-guild, so double-check here too.
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({
                content: 'Only server administrators can restart the bot.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.reply(
            'Restarting now. Note: this exits the process — it only comes back automatically if it\'s ' +
            'run under a process manager that restarts on exit (e.g. pm2, systemd, Docker restart policy).',
        );
        setTimeout(() => process.exit(0), 500);
    },
};

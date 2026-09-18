const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getGuildConfig, setGuildNotionConfig, upsertUserMapping, getUserMappingsByGuild, deleteUserMapping } = require('../../lib/guildConfig');
const { getNotionClient, validateWikiPageAccess } = require('../../lib/notion');
const { scanNotionWiki } = require('../../lib/notionScanner');
const { getGuildWiki, getNotionItemsByGuild } = require('../../lib/database');
const { sendSafeChunkedReply } = require('../../lib/discordUtils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('notion')
        .setDescription('Configure and manage Notion workspace integration')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        // Subcommand: setup
        .addSubcommand((sub) =>
            sub
                .setName('setup')
                .setDescription('Configure the Notion API token and Central Wiki Page ID')
                .addStringOption((opt) =>
                    opt
                        .setName('token')
                        .setDescription('Your Notion Integration API Secret Token (starts with ntn_)')
                        .setRequired(true)
                )
                .addStringOption((opt) =>
                    opt
                        .setName('wiki_page_id')
                        .setDescription('The UUID or full URL of your Central Wiki Root Page')
                        .setRequired(true)
                )
        )
        // Subcommand: scan
        .addSubcommand((sub) =>
            sub
                .setName('scan')
                .setDescription('Perform a recursive scan of the Central Wiki and cache pages/databases')
                .addIntegerOption((opt) =>
                    opt
                        .setName('depth')
                        .setDescription('Scan depth (default: 3)')
                        .setRequired(false)
                )
                .addIntegerOption((opt) =>
                    opt
                        .setName('limit')
                        .setDescription('Maximum page/database items to scan (default: 100)')
                        .setRequired(false)
                )
        )
        // Subcommand: status
        .addSubcommand((sub) =>
            sub
                .setName('status')
                .setDescription('View Notion integration settings, cached items, and member mappings')
        )
        // Subcommand: link-member
        .addSubcommand((sub) =>
            sub
                .setName('link-member')
                .setDescription('Link a Discord server member to their Notion user profile')
                .addUserOption((opt) =>
                    opt
                        .setName('discord_user')
                        .setDescription('Select the Discord user')
                        .setRequired(true)
                )
                .addStringOption((opt) =>
                    opt
                        .setName('notion_name_or_email')
                        .setDescription('Their exact Notion Name or email address')
                        .setRequired(true)
                )
        ),

    async execute(interaction) {
        const guildId = interaction.guildId;
        if (!guildId) {
            return interaction.reply({
                content: 'This command can only be used within a Discord server.',
                flags: [64], // Ephemeral
            });
        }

        const subcommand = interaction.options.getSubcommand();

        try {
            switch (subcommand) {
                case 'setup': {
                    const token = interaction.options.getString('token').trim();
                    const wikiInput = interaction.options.getString('wiki_page_id').trim();

                    // Parse/normalize Wiki ID
                    const uuidRegex = /[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}/;
                    const match = wikiInput.match(uuidRegex);
                    const cleanWikiId = match ? match[0].replace(/-/g, '') : wikiInput.replace(/-/g, '');

                    await interaction.deferReply({ flags: [64] }); // Ephemeral defer for security

                    // Validate access
                    try {
                        const hasAccess = await validateWikiPageAccess(token, cleanWikiId);
                        if (!hasAccess) {
                            return interaction.editReply({
                                content: '❌ Could not verify access to the provided Wiki Root Page ID. Check your Notion Integration Token and ensure your Integration is added to the page.',
                            });
                        }
                    } catch (err) {
                        return interaction.editReply({
                            content: `❌ Notion Access Verification failed: ${err.message}`,
                        });
                    }

                    // Save config
                    setGuildNotionConfig(guildId, {
                        notionToken: token,
                        wikiPageId: cleanWikiId,
                    });

                    return interaction.editReply({
                        content: `✅ **Notion Integration Saved successfully!**\n- Wiki Page ID: \`${cleanWikiId}\`\n\nRun \`/notion scan\` to perform your first workspace search index crawl!`,
                    });
                }

                case 'scan': {
                    const config = getGuildConfig(guildId);
                    if (!config.notionToken || !config.wikiPageId) {
                        return interaction.reply({
                            content: '❌ Notion integration is not set up yet. Run `/notion setup` first.',
                            flags: [64],
                        });
                    }

                    await interaction.deferReply();

                    const depth = interaction.options.getInteger('depth') || 3;
                    const limit = interaction.options.getInteger('limit') || 100;

                    await interaction.editReply({
                        content: `⏳ Starting recursive scan of Notion Central Wiki...\n- Depth Limit: \`${depth}\`\n- Item Limit: \`${limit}\`\n*(Please wait, this may take up to a minute depending on workspace size)*`,
                    });

                    const result = await scanNotionWiki(guildId, config.notionToken, config.wikiPageId, {
                        maxDepth: depth,
                        maxItems: limit,
                    });

                    if (result.success) {
                        return interaction.editReply({
                            content: `✅ **Notion Central Wiki Scan Complete!**\n- Items Scanned & Cached: \`${result.itemsScannedCount}\`\n- Total Time: \`${result.durationSeconds}s\`\n\nGrounding context has been compiled and indexed. You can now use \`/ask\` to query the wiki workspace!`,
                        });
                    } else {
                        return interaction.editReply({
                            content: `❌ **Wiki Scan Failed:** ${result.error}`,
                        });
                    }
                }

                case 'status': {
                    const config = getGuildConfig(guildId);
                    if (!config.notionToken) {
                        return interaction.reply({
                            content: '❌ Notion Integration is not configured for this server.',
                            flags: [64],
                        });
                    }

                    const wiki = getGuildWiki(guildId);
                    const items = getNotionItemsByGuild(guildId);
                    const mappings = getUserMappingsByGuild(guildId);

                    const pagesCount = items.filter((i) => i.type === 'page').length;
                    const databasesCount = items.filter((i) => i.type === 'database').length;
                    const tasksCount = items.filter((i) => i.type === 'task').length;

                    const statusStr = `## 📊 Notion Integration Status
- **Wiki Page ID**: \`${config.wikiPageId}\`
- **Sync Mode**: \`${config.syncMode || 'manual'}\`
- **Last Crawl**: ${wiki?.last_scanned_at ? `<t:${Math.floor(wiki.last_scanned_at / 1000)}:f>` : '`Never`'}

### 🗄️ SQLite Caches
- **Total Cached Items**: \`${items.length}\`
  - 📄 Pages: \`${pagesCount}\`
  - 🗄️ Databases: \`${databasesCount}\`
  - 📝 Tasks/Rows: \`${tasksCount}\`

### 👥 Linked Members (${mappings.length})
${mappings.map((m) => `- <@${m.discord_user_id}> ➡️ **Notion: ${m.notion_user_name}** *(ID: ${m.notion_user_id || 'Not verified'})*`).join('\n') || '_No members linked yet. Use `/notion link-member` to map users._'}`;

                    return interaction.reply({ content: statusStr });
                }

                case 'link-member': {
                    const config = getGuildConfig(guildId);
                    if (!config.notionToken) {
                        return interaction.reply({
                            content: '❌ Notion Integration is not set up. Run `/notion setup` first.',
                            flags: [64],
                        });
                    }

                    await interaction.deferReply({ flags: [64] });

                    const discordUser = interaction.options.getUser('discord_user');
                    const targetNameOrEmail = interaction.options.getString('notion_name_or_email').trim();

                    const client = getNotionClient(config.notionToken);

                    let notionUserId = null;
                    let matchedName = targetNameOrEmail;

                    try {
                        const usersRes = await client.users.list({});
                        const targetLower = targetNameOrEmail.toLowerCase();

                        // Try to find matching user in workspace
                        const matchedUser = (usersRes.results || []).find((u) => {
                            if (u.type !== 'person') return false;
                            if (u.name?.toLowerCase() === targetLower) return true;
                            if (u.person?.email?.toLowerCase() === targetLower) return true;
                            return false;
                        });

                        if (matchedUser) {
                            notionUserId = matchedUser.id;
                            matchedName = matchedUser.name || matchedName;
                        }
                    } catch (err) {
                        console.warn('[notionCommand] Warning fetching Notion users list:', err.message);
                    }

                    upsertUserMapping(guildId, discordUser.id, discordUser.displayName, matchedName, notionUserId);

                    const verifyNote = notionUserId
                        ? `✅ Linked <@${discordUser.id}> to Notion User **${matchedName}** *(ID: ${notionUserId})*!`
                        : `⚠️ Linked <@${discordUser.id}> to Notion Name **${matchedName}** (could not verify ID in workspace users list).`;

                    return interaction.editReply({ content: verifyNote });
                }
            }
        } catch (err) {
            console.error('[notionCommand] Error:', err);
            return interaction.reply({
                content: `❌ Error: ${err.message}`,
                flags: [64],
            }).catch(() => {
                interaction.followUp({ content: `❌ Error: ${err.message}`, flags: [64] });
            });
        }
    },
};

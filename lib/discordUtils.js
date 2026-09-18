const { AttachmentBuilder } = require('discord.js');

/**
 * Splits markdown text into chunks that comply with Discord's 2000-character message limit.
 * Defaults to 1900 characters to safely allow room for markdown formatting and embeds.
 *
 * Preserves code blocks (```) across chunks so syntax highlighting and formatting
 * are maintained seamlessly in Discord.
 *
 * @param {string} text - The input markdown text.
 * @param {number} [maxLength=1900] - Maximum length per chunk.
 * @returns {string[]} Array of chunked strings.
 */
function splitDiscordText(text, maxLength = 1900) {
    if (!text || typeof text !== 'string') return [];
    if (text.length <= maxLength) return [text];

    const lines = text.split('\n');
    const chunks = [];
    let currentChunk = '';
    let inCodeBlock = false;
    let codeLanguage = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const codeBlockMatch = line.match(/^```([a-zA-Z0-9_-]*)/);
        if (codeBlockMatch) {
            if (!inCodeBlock) {
                inCodeBlock = true;
                codeLanguage = codeBlockMatch[1] || '';
            } else {
                inCodeBlock = false;
                codeLanguage = '';
            }
        }

        // Handle single lines that exceed maxLength
        if (line.length > maxLength) {
            if (currentChunk.length > 0) {
                if (inCodeBlock) currentChunk += '\n```';
                chunks.push(currentChunk.trim());
                currentChunk = inCodeBlock ? `\`\`\`${codeLanguage}\n` : '';
            }

            for (let c = 0; c < line.length; c += maxLength) {
                const slice = line.slice(c, c + maxLength);
                if (c + maxLength >= line.length) {
                    currentChunk = slice;
                } else {
                    chunks.push(slice);
                }
            }
            continue;
        }

        const potentialChunk = currentChunk.length === 0 ? line : currentChunk + '\n' + line;
        const projectedLength = potentialChunk.length + (inCodeBlock ? 4 : 0);

        if (projectedLength > maxLength) {
            if (inCodeBlock) {
                currentChunk += '\n```';
            }
            chunks.push(currentChunk.trim());
            currentChunk = inCodeBlock ? `\`\`\`${codeLanguage}\n${line}` : line;
        } else {
            currentChunk = potentialChunk;
        }
    }

    if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}

/**
 * Truncates text safely with an ellipsis suffix if it exceeds maxLength.
 *
 * @param {string} text
 * @param {number} [maxLength=1900]
 * @param {string} [suffix='...']
 * @returns {string}
 */
function truncateDiscordText(text, maxLength = 1900, suffix = '...') {
    if (!text || typeof text !== 'string') return '';
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - suffix.length) + suffix;
}

/**
 * Delivers a potentially long response to a deferred interaction.
 * Splits across interaction.editReply and interaction.followUp up to maxChunks,
 * or attaches the full text as a file if the response is exceptionally large.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string} fullContent
 * @param {object} [options={}]
 * @param {number} [maxFollowUps=3]
 */
async function sendSafeChunkedReply(interaction, fullContent, options = {}, maxFollowUps = 3) {
    if (!fullContent || fullContent.length <= 1900) {
        return await interaction.editReply({
            content: fullContent,
            ...options,
        });
    }

    const chunks = splitDiscordText(fullContent, 1900);

    // If within reasonable chunk count (e.g. up to 4 messages total)
    if (chunks.length <= maxFollowUps + 1) {
        await interaction.editReply({
            content: chunks[0],
            ...options,
        });

        for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp({
                content: chunks[i],
            });
        }
        return;
    }

    // If exceptionally large, send preview and attach markdown file
    const attachment = new AttachmentBuilder(Buffer.from(fullContent, 'utf-8'), {
        name: options.fileName || 'assistant_response.md',
    });

    const files = options.files ? [...options.files, attachment] : [attachment];
    const notice = '\n\n*(Full response exceeds Discord display limit — complete response attached below)*';
    const preview = truncateDiscordText(chunks[0], 1900 - notice.length) + notice;

    await interaction.editReply({
        content: preview,
        files,
        components: options.components,
    });
}

/**
 * Delivers a potentially long response replying to a user Message.
 *
 * @param {import('discord.js').Message} message
 * @param {string} fullContent
 * @param {object} [options={}]
 * @param {number} [maxFollowUps=3]
 */
async function sendSafeMessageReply(message, fullContent, options = {}, maxFollowUps = 3) {
    if (!fullContent || fullContent.length <= 1900) {
        return await message.reply({
            content: fullContent,
            ...options,
        });
    }

    const chunks = splitDiscordText(fullContent, 1900);

    if (chunks.length <= maxFollowUps + 1) {
        await message.reply({
            content: chunks[0],
            ...options,
        });

        if (message.channel) {
            for (let i = 1; i < chunks.length; i++) {
                await message.channel.send({
                    content: chunks[i],
                });
            }
        }
        return;
    }

    const attachment = new AttachmentBuilder(Buffer.from(fullContent, 'utf-8'), {
        name: options.fileName || 'assistant_response.md',
    });

    const files = options.files ? [...options.files, attachment] : [attachment];
    const notice = '\n\n*(Full response exceeds Discord display limit — complete response attached below)*';
    const preview = truncateDiscordText(chunks[0], 1900 - notice.length) + notice;

    await message.reply({
        content: preview,
        files,
    });
}

module.exports = {
    splitDiscordText,
    truncateDiscordText,
    sendSafeChunkedReply,
    sendSafeMessageReply,
};

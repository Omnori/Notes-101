const { Client } = require('@notionhq/client');
const { getNotionClient, withRetry } = require('./notion');
const { upsertNotionItem, upsertGuildWiki, logAudit } = require('./database');

/**
 * Extracts plain text from a rich text property or title property.
 */
function getRichTextPlain(richTextArray) {
    if (!richTextArray || !Array.isArray(richTextArray)) return '';
    return richTextArray.map((t) => t.plain_text || t.text?.content || '').join('');
}

/**
 * Extracts text from a Notion block depending on its type.
 */
function getBlockText(block) {
    if (!block || !block.type) return '';
    const typeData = block[block.type];
    if (!typeData) return '';
    if (Array.isArray(typeData.rich_text)) {
        return getRichTextPlain(typeData.rich_text);
    }
    if (Array.isArray(typeData.title)) {
        return getRichTextPlain(typeData.title);
    }
    return '';
}

/**
 * Parses page properties from a database page.
 */
function parseDatabaseProperties(properties) {
    const parsed = {};
    if (!properties || typeof properties !== 'object') return parsed;

    for (const [key, value] of Object.entries(properties)) {
        const type = value.type;
        if (!type) continue;

        if (type === 'title') {
            parsed[key] = getRichTextPlain(value.title);
        } else if (type === 'rich_text') {
            parsed[key] = getRichTextPlain(value.rich_text);
        } else if (type === 'status') {
            parsed[key] = value.status?.name || null;
        } else if (type === 'select') {
            parsed[key] = value.select?.name || null;
        } else if (type === 'multi_select') {
            parsed[key] = (value.multi_select || []).map((s) => s.name);
        } else if (type === 'people') {
            parsed[key] = (value.people || []).map((p) => ({
                id: p.id,
                name: p.name || null,
                email: p.person?.email || null,
            }));
        } else if (type === 'date') {
            parsed[key] = value.date ? { start: value.date.start, end: value.date.end } : null;
        } else if (type === 'checkbox') {
            parsed[key] = !!value.checkbox;
        } else if (type === 'number') {
            parsed[key] = value.number;
        } else if (type === 'url') {
            parsed[key] = value.url;
        } else if (type === 'email') {
            parsed[key] = value.email;
        } else if (type === 'phone_number') {
            parsed[key] = value.phone_number;
        }
    }
    return parsed;
}

/**
 * Helper to identify Title, Status, Assignee, and Due Date properties from database schema properties.
 */
function extractStandardProperties(parsedProperties) {
    let title = '';
    let status = null;
    let assignee = null;
    let dueDate = null;

    for (const [key, val] of Object.entries(parsedProperties)) {
        const lowerKey = key.toLowerCase();
        if (lowerKey === 'title' || lowerKey === 'name') {
            title = String(val);
        } else if (lowerKey === 'status' || lowerKey === 'state' || lowerKey === 'stage') {
            status = Array.isArray(val) ? val.join(', ') : String(val);
        } else if (lowerKey === 'assignee' || lowerKey === 'owner' || lowerKey === 'assigned to') {
            if (Array.isArray(val)) {
                assignee = val.map((p) => p.name || p.id || String(p)).join(', ');
            } else if (val && typeof val === 'object') {
                assignee = val.name || val.id || JSON.stringify(val);
            } else {
                assignee = val ? String(val) : null;
            }
        } else if (lowerKey === 'due' || lowerKey === 'due date' || lowerKey === 'deadline' || lowerKey === 'date') {
            if (val && typeof val === 'object') {
                dueDate = val.start || JSON.stringify(val);
            } else {
                dueDate = val ? String(val) : null;
            }
        }
    }

    return { title, status, assignee, dueDate };
}

/**
 * Converts a set of Notion blocks to Markdown content recursively.
 */
async function fetchBlocksToMarkdown(client, blockId, maxRecurseDepth = 3, currentRecurseDepth = 0) {
    if (currentRecurseDepth > maxRecurseDepth) return '';
    const markdownLines = [];
    let cursor = undefined;

    try {
        do {
            const res = await withRetry(() => client.blocks.children.list({
                block_id: blockId,
                start_cursor: cursor,
                page_size: 100,
            }));

            for (const b of (res.results || [])) {
                const text = getBlockText(b).trim();
                const type = b.type;

                if (type === 'heading_1') {
                    markdownLines.push(`\n# ${text}\n`);
                } else if (type === 'heading_2') {
                    markdownLines.push(`\n## ${text}\n`);
                } else if (type === 'heading_3') {
                    markdownLines.push(`\n### ${text}\n`);
                } else if (type === 'bulleted_list_item') {
                    markdownLines.push(`* ${text}`);
                } else if (type === 'numbered_list_item') {
                    markdownLines.push(`1. ${text}`);
                } else if (type === 'to_do') {
                    const checked = b.to_do?.checked ? '[x]' : '[ ]';
                    markdownLines.push(`* ${checked} ${text}`);
                } else if (type === 'paragraph') {
                    if (text) markdownLines.push(text);
                } else if (type === 'quote') {
                    markdownLines.push(`> ${text}`);
                } else if (type === 'callout') {
                    markdownLines.push(`> [Notice] ${text}`);
                } else if (type === 'code') {
                    const language = b.code?.language || 'text';
                    const codeText = getRichTextPlain(b.code?.rich_text) || '';
                    markdownLines.push(`\`\`\`${language}\n${codeText}\n\`\`\``);
                } else if (type === 'child_page') {
                    markdownLines.push(`\n🔗 *Child Page: [${b.child_page?.title || 'Untitled'}](${b.id})*\n`);
                } else if (type === 'child_database') {
                    markdownLines.push(`\n🔗 *Child Database: [${b.child_database?.title || 'Untitled'}](${b.id})*\n`);
                }

                // If block has children and is container type (and NOT page/database which we crawl separately), recurse content
                if (b.has_children && type !== 'child_page' && type !== 'child_database') {
                    const childMd = await fetchBlocksToMarkdown(client, b.id, maxRecurseDepth, currentRecurseDepth + 1);
                    if (childMd.trim()) {
                        const indent = '  ';
                        const indented = childMd.split('\n').map((line) => line ? indent + line : line).join('\n');
                        markdownLines.push(indented);
                    }
                }
            }

            cursor = res.has_more ? res.next_cursor : undefined;
        } while (cursor);
    } catch (err) {
        console.warn(`[notionScanner] Error converting blocks to markdown for ${blockId}:`, err.message);
    }

    return markdownLines.join('\n');
}

/**
 * Performs a deep, recursive scan of the Notion Wiki and caches all pages and databases in SQLite.
 * Builds and stores a structural table of contents.
 */
async function scanNotionWiki(guildId, token, rootPageId, options = {}) {
    const maxDepth = options.maxDepth !== undefined ? options.maxDepth : 3;
    const maxItems = options.maxItems !== undefined ? options.maxItems : 100;

    const client = options.notionClient || getNotionClient(token);
    const scannedIds = new Set();
    const tocLines = [];
    const structure = [];

    let itemsScannedCount = 0;
    const startTime = Date.now();

    // Helper to retrieve block / page / database details and content
    async function scanNode(nodeId, parentId = null, databaseId = null, depth = 0) {
        if (scannedIds.has(nodeId)) return;
        if (depth > maxDepth) return;
        if (itemsScannedCount >= maxItems) return;

        scannedIds.add(nodeId);
        itemsScannedCount++;

        const indent = '  '.repeat(depth);
        let nodeTitle = 'Untitled';
        let nodeType = 'page';
        let url = `https://notion.so/${nodeId.replace(/-/g, '')}`;
        let status = null;
        let assignee = null;
        let dueDate = null;
        let propertiesJson = null;
        let contentMarkdown = '';

        try {
            // 1. Determine type and retrieve details
            let blockInfo;
            try {
                blockInfo = await withRetry(() => client.blocks.retrieve({ block_id: nodeId }));
            } catch (blockErr) {
                // If retrieve block fails, try treating as a page directly
                try {
                    const pageInfo = await withRetry(() => client.pages.retrieve({ page_id: nodeId }));
                    nodeType = 'page';
                    nodeTitle = getRichTextPlain(pageInfo.properties?.title?.title || pageInfo.properties?.Name?.title || []);
                    if (pageInfo.url) url = pageInfo.url;
                } catch {
                    // Try treating as database directly
                    const dbInfo = await withRetry(() => client.databases.retrieve({ database_id: nodeId }));
                    nodeType = 'database';
                    nodeTitle = getRichTextPlain(dbInfo.title || []);
                    if (dbInfo.url) url = dbInfo.url;
                }
            }

            if (blockInfo) {
                if (blockInfo.type === 'child_page') {
                    nodeType = 'page';
                    nodeTitle = blockInfo.child_page?.title || 'Untitled Page';
                } else if (blockInfo.type === 'child_database') {
                    nodeType = 'database';
                    nodeTitle = blockInfo.child_database?.title || 'Untitled Database';
                } else {
                    // Fallback to page retrieve
                    try {
                        const pageInfo = await withRetry(() => client.pages.retrieve({ page_id: nodeId }));
                        nodeType = 'page';
                        nodeTitle = getRichTextPlain(pageInfo.properties?.title?.title || pageInfo.properties?.Name?.title || []);
                        if (pageInfo.url) url = pageInfo.url;
                    } catch {
                        // Keep defaults
                    }
                }
            }

            // 2. Fetch block contents for markdown compilation
            if (nodeType === 'page') {
                contentMarkdown = await fetchBlocksToMarkdown(client, nodeId, 3, 0);
            }

            // 3. Save Node to Cache
            upsertNotionItem({
                id: nodeId,
                guildId,
                parentId,
                databaseId,
                type: nodeType,
                title: nodeTitle,
                status,
                assignee,
                dueDate,
                propertiesJson: null,
                contentMarkdown,
                url,
                updatedAt: Date.now(),
            });

            // 4. Update structural lists
            const itemEmoji = nodeType === 'database' ? '🗄️' : '📄';
            tocLines.push(`${indent}- ${itemEmoji} **[${nodeTitle}](${url})** *(ID: ${nodeId})*`);

            const structNode = {
                id: nodeId,
                title: nodeTitle,
                type: nodeType,
                url,
                depth,
                children: [],
            };
            structure.push(structNode);

            // 5. Recurse into children
            if (nodeType === 'database') {
                // Fetch up to 40 items from database
                const dbResults = await withRetry(() => client.databases.query({
                    database_id: nodeId,
                    page_size: 40,
                }));

                for (const row of (dbResults.results || [])) {
                    if (itemsScannedCount >= maxItems) break;

                    const rowProps = parseDatabaseProperties(row.properties);
                    const stdProps = extractStandardProperties(rowProps);
                    const rowTitle = stdProps.title || 'Untitled Row';
                    const rowUrl = row.url || `https://notion.so/${row.id.replace(/-/g, '')}`;

                    scannedIds.add(row.id);
                    itemsScannedCount++;

                    // Fetch page contents
                    const rowMarkdown = await fetchBlocksToMarkdown(client, row.id, 2, 0);

                    upsertNotionItem({
                        id: row.id,
                        guildId,
                        parentId: nodeId,
                        databaseId: nodeId,
                        type: 'task', // treat database entries as tasks/documents
                        title: rowTitle,
                        status: stdProps.status,
                        assignee: stdProps.assignee,
                        dueDate: stdProps.dueDate,
                        propertiesJson: JSON.stringify(rowProps),
                        contentMarkdown: rowMarkdown,
                        url: rowUrl,
                        updatedAt: Date.now(),
                    });

                    tocLines.push(`${indent}  - 📝 **[${rowTitle}](${rowUrl})** *(ID: ${row.id})* [Status: ${stdProps.status || 'None'}]`);
                    structNode.children.push({
                        id: row.id,
                        title: rowTitle,
                        type: 'task',
                        url: rowUrl,
                        status: stdProps.status,
                        assignee: stdProps.assignee,
                        dueDate: stdProps.dueDate,
                        depth: depth + 1,
                    });
                }
            } else if (nodeType === 'page') {
                // Find all nested child_page and child_database blocks of this page
                let childBlocks = [];
                let childCursor = undefined;
                try {
                    do {
                        const childRes = await withRetry(() => client.blocks.children.list({
                            block_id: nodeId,
                            start_cursor: childCursor,
                            page_size: 100,
                        }));
                        childBlocks.push(...(childRes.results || []));
                        childCursor = childRes.has_more ? childRes.next_cursor : undefined;
                    } while (childCursor);
                } catch {
                    // Ignore failures
                }

                const subItems = childBlocks.filter((b) => b.type === 'child_page' || b.type === 'child_database');
                for (const child of subItems) {
                    await scanNode(child.id, nodeId, databaseId, depth + 1);
                }
            }
        } catch (nodeErr) {
            console.error(`[notionScanner] Error scanning node ${nodeId}:`, nodeErr.message);
            tocLines.push(`${indent}- ⚠️ *Failed to load node ${nodeId} (${nodeErr.message})*`);
        }
    }

    try {
        logAudit({
            guildId,
            userId: 'SYSTEM',
            userTag: 'System',
            action: 'WIKI_SCAN_START',
            details: { rootPageId, maxDepth, maxItems },
        });

        // Run recursive scanning
        await scanNode(rootPageId, null, null, 0);

        const tocMarkdown = tocLines.join('\n');

        // Save the compiled TOC and structure JSON
        upsertGuildWiki(guildId, rootPageId, tocMarkdown, JSON.stringify(structure), Date.now());

        const durationSeconds = ((Date.now() - startTime) / 1000).toFixed(1);

        logAudit({
            guildId,
            userId: 'SYSTEM',
            userTag: 'System',
            action: 'WIKI_SCAN_COMPLETE',
            details: {
                rootPageId,
                durationSeconds,
                itemsScanned: itemsScannedCount,
                scannedPages: Array.from(scannedIds),
            },
        });

        return {
            success: true,
            itemsScannedCount,
            durationSeconds,
            tocMarkdown,
            structure,
        };
    } catch (err) {
        console.error('[notionScanner] Wiki scan failed:', err);
        logAudit({
            guildId,
            userId: 'SYSTEM',
            userTag: 'System',
            action: 'WIKI_SCAN_FAIL',
            details: { error: err.message },
        });
        return {
            success: false,
            error: err.message,
        };
    }
}

module.exports = {
    scanNotionWiki,
    fetchBlocksToMarkdown,
    parseDatabaseProperties,
    extractStandardProperties,
};

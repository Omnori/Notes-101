const { Client } = require('@notionhq/client');
const { markdownToBlocks } = require('@tryfabric/martian');

/**
 * Normalizes a Notion URL or ID into a clean Notion ID.
 * Accepts full URLs (e.g. https://notion.so/workspace/Page-Name-18e47458113c809e86a9f0611e0337c7)
 * or 32-character hex UUIDs with or without hyphens.
 */
function normalizeNotionId(input) {
    if (!input || typeof input !== 'string') return null;
    const clean = input.trim();

    // Match 32-hex UUID (with or without hyphens)
    const uuidRegex = /[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}/;
    const match = clean.match(uuidRegex);
    if (match) {
        return match[0].replace(/-/g, '');
    }

    // If it's already a 32-character hex string
    if (/^[0-9a-fA-F]{32}$/.test(clean)) {
        return clean;
    }

    return clean;
}

/**
 * Masks a sensitive token for safe display in logs and Discord replies.
 * Never leaks the full token.
 */
function maskToken(token) {
    if (!token || typeof token !== 'string') return '_not set_';
    const trimmed = token.trim();
    if (trimmed.length <= 8) return '`****`';
    return `\`${trimmed.slice(0, 4)}...${trimmed.slice(-4)}\``;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RETRYABLE_NETWORK_CODES = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNABORTED',
    'UND_ERR_CONNECT_TIMEOUT',
    'AbortError',
]);

function isRetryableError(err) {
    if (!err) return false;
    const status = err.status || err.statusCode;

    // Explicitly non-retryable HTTP status codes
    if (status === 400 || status === 401 || status === 403 || status === 404) {
        return false;
    }

    // Explicitly retryable HTTP status codes
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;

    // Transient network socket errors
    const code = err.code || err.name;
    if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;

    // Reject known client / validation error message signatures
    const msg = String(err.message || '').toLowerCase();
    if (
        msg.includes('validation_error') ||
        msg.includes('unauthorized') ||
        msg.includes('forbidden') ||
        msg.includes('object_not_found') ||
        msg.includes('invalid_request')
    ) {
        return false;
    }

    // Fallback message checks for transient fetch/network/rate-limit errors
    if (msg.includes('fetch failed') || msg.includes('timeout') || msg.includes('network') || msg.includes('rate limit')) {
        return true;
    }

    return false;
}

/**
 * Retry helper with exponential backoff and jitter for Notion API calls.
 * Respects Notion rate limits (~3 requests/sec), transient 5xx errors, and network disconnects.
 * Honors Retry-After header on 429 rate limits without under-waiting.
 */
async function withRetry(operation, maxRetries = 3, initialDelayMs = 500) {
    let delay = initialDelayMs;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (err) {
            if (isRetryableError(err) && attempt < maxRetries) {
                const retryAfterHeader = err.headers?.get?.('retry-after') || err.headers?.['retry-after'];
                let waitMs;
                if (retryAfterHeader) {
                    const parsedSeconds = parseFloat(retryAfterHeader);
                    waitMs = !isNaN(parsedSeconds) && parsedSeconds > 0
                        ? Math.min(15000, parsedSeconds * 1000 + Math.random() * 200)
                        : delay;
                } else {
                    waitMs = Math.min(10000, delay * (0.8 + Math.random() * 0.4));
                    delay = Math.min(10000, delay * 2);
                }
                await sleep(waitMs);
                continue;
            }
            throw err;
        }
    }
}

/**
 * Creates an instance of the Notion Client.
 */
function getNotionClient(token) {
    if (!token) {
        throw new Error('Notion token is required to create a Notion client.');
    }
    return new Client({ auth: token });
}

/**
 * Safely extracts the plain text title from a Notion page object.
 */
function extractPageTitle(page) {
    if (!page) return 'Untitled';
    if (page.properties) {
        for (const prop of Object.values(page.properties)) {
            if (prop && prop.type === 'title' && Array.isArray(prop.title)) {
                const text = prop.title.map((t) => t.plain_text || t.text?.content || '').join('');
                if (text.trim()) return text.trim();
            }
        }
    }
    return 'Untitled';
}

/**
 * Validates that the provided Notion integration token has read access to the specified wiki page.
 * Distinguishes between authorization failure, missing connection/share, and other errors.
 */
async function validateWikiPageAccess(token, rawWikiId) {
    const pageId = normalizeNotionId(rawWikiId);
    if (!pageId) {
        return {
            valid: false,
            pageId: null,
            errorType: 'invalid_id',
            message: 'The provided wiki page ID or URL could not be parsed.',
        };
    }

    try {
        const client = getNotionClient(token);
        const page = await withRetry(() => client.pages.retrieve({ page_id: pageId }));
        if (page.in_trash || page.archived) {
            return {
                valid: false,
                pageId,
                isArchivedOrTrashed: true,
                errorType: 'archived_or_trashed',
                message: 'The specified Notion Wiki page is in the trash or archived.',
            };
        }
        const title = extractPageTitle(page);

        return {
            valid: true,
            pageId,
            title,
            page,
        };
    } catch (err) {
        const status = err.status || err.statusCode;
        const code = err.code;
        const isConnectionShareError = status === 404 || code === 'object_not_found';
        const isUnauthorized = status === 401 || code === 'unauthorized';

        return {
            valid: false,
            pageId,
            status,
            code,
            isConnectionShareError,
            isUnauthorized,
            error: err,
            message: err.message || 'Unknown Notion error',
        };
    }
}

/**
 * Retrieves title and connection status for an already configured wiki page.
 */
async function getWikiPageInfo(token, pageId) {
    return validateWikiPageAccess(token, pageId);
}

/**
 * Scans direct children blocks of a page to identify child databases and child pages.
 * Handles pagination automatically and filters out trashed/archived items.
 */
async function findDirectChildren(client, parentPageId) {
    const databases = new Map(); // lowercase title -> database id
    const pages = new Map();     // lowercase title -> page id

    let cursor = undefined;
    do {
        const res = await withRetry(() => client.blocks.children.list({
            block_id: parentPageId,
            start_cursor: cursor,
            page_size: 100,
        }));

        for (const block of res.results) {
            if (block.in_trash || block.archived) continue;

            if (block.type === 'child_database' && block.child_database?.title) {
                const title = block.child_database.title.toLowerCase().trim();
                if (!databases.has(title)) {
                    databases.set(title, block.id);
                }
            } else if (block.type === 'child_page' && block.child_page?.title) {
                const title = block.child_page.title.toLowerCase().trim();
                if (!pages.has(title)) {
                    pages.set(title, block.id);
                }
            }
        }

        cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);

    return { databases, pages };
}

/**
 * Idempotently provisions the required child pages and databases under the wiki page:
 * 1. "Meetings" database (properties: Date, Channel, Participants)
 * 2. "Org Info" page (with starter sections for People, Projects, Decisions)
 * 3. "Action Items" database (properties: Task, Status, Assignee, Due)
 * 4. "Members" database (properties: Name, Discord ID, Role)
 *
 * Verifies and searches by title first to ensure no duplicate pages are created.
 */
async function provisionWikiStructure(token, wikiPageId, existingConfig = {}, notionClient = null) {
    const client = notionClient || getNotionClient(token);
    const created = { meetings: false, orgInfo: false, actionItems: false, members: false };

    let meetingsDbId = existingConfig.meetingsDbId || null;
    let orgInfoPageId = existingConfig.orgInfoPageId || null;
    let actionItemsDbId = existingConfig.actionItemsDbId || null;
    let membersDbId = existingConfig.membersDbId || null;

    // Verify existing IDs if provided in config, ignoring trashed or archived entities
    if (meetingsDbId) {
        try {
            const db = await withRetry(() => client.databases.retrieve({ database_id: meetingsDbId }));
            if (db.in_trash || db.archived) meetingsDbId = null;
        } catch {
            meetingsDbId = null;
        }
    }
    if (orgInfoPageId) {
        try {
            const page = await withRetry(() => client.pages.retrieve({ page_id: orgInfoPageId }));
            if (page.in_trash || page.archived) orgInfoPageId = null;
        } catch {
            orgInfoPageId = null;
        }
    }
    if (actionItemsDbId) {
        try {
            const db = await withRetry(() => client.databases.retrieve({ database_id: actionItemsDbId }));
            if (db.in_trash || db.archived) actionItemsDbId = null;
        } catch {
            actionItemsDbId = null;
        }
    }
    if (membersDbId) {
        try {
            const db = await withRetry(() => client.databases.retrieve({ database_id: membersDbId }));
            if (db.in_trash || db.archived) membersDbId = null;
        } catch {
            membersDbId = null;
        }
    }

    // If any IDs are missing, scan direct children of wikiPageId first
    if (!meetingsDbId || !orgInfoPageId || !actionItemsDbId || !membersDbId) {
        const { databases, pages } = await findDirectChildren(client, wikiPageId);

        if (!meetingsDbId && databases.has('meetings')) {
            meetingsDbId = databases.get('meetings');
        }
        if (!orgInfoPageId && pages.has('org info')) {
            orgInfoPageId = pages.get('org info');
        }
        if (!actionItemsDbId && databases.has('action items')) {
            actionItemsDbId = databases.get('action items');
        }
        if (!membersDbId && databases.has('members')) {
            membersDbId = databases.get('members');
        }
    }

    // 1. Provision "Meetings" database if not found
    if (!meetingsDbId) {
        const db = await withRetry(() => client.databases.create({
            parent: { type: 'page_id', page_id: wikiPageId },
            title: [{ type: 'text', text: { content: 'Meetings' } }],
            icon: { type: 'emoji', emoji: '📅' },
            initial_data_source: {
                properties: {
                    Name: { title: {} },
                    Date: { date: {} },
                    Channel: { rich_text: {} },
                    Participants: { rich_text: {} },
                },
            },
            properties: {
                Name: { title: {} },
                Date: { date: {} },
                Channel: { rich_text: {} },
                Participants: { rich_text: {} },
            },
        }));
        meetingsDbId = db.id;
        created.meetings = true;
    }

    // 2. Provision "Org Info" page if not found
    if (!orgInfoPageId) {
        const page = await withRetry(() => client.pages.create({
            parent: { type: 'page_id', page_id: wikiPageId },
            icon: { type: 'emoji', emoji: '🏢' },
            properties: {
                title: [{ type: 'text', text: { content: 'Org Info' } }],
            },
            children: [
                {
                    object: 'block',
                    type: 'callout',
                    callout: {
                        rich_text: [{
                            type: 'text',
                            text: { content: 'Central organization memory and dynamic ground truth for Notes 101. Updated from meetings and team syncs with reference to the Central Wiki.' },
                        }],
                        icon: { type: 'emoji', emoji: '🏢' },
                    },
                },
                {
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ type: 'text', text: { content: '📢 Sprint Focus & Priorities' } }],
                    },
                },
                {
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ type: 'text', text: { content: 'Current sprint goals, notice board announcements, and operational priorities.' } }],
                    },
                },
                {
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ type: 'text', text: { content: '🚀 Active Products & Tech Lab' } }],
                    },
                },
                {
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ type: 'text', text: { content: 'Proprietary software products, tools, browser extensions, and technical R&D.' } }],
                    },
                },
                {
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ type: 'text', text: { content: '🎯 Clients & Partnerships' } }],
                    },
                },
                {
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ type: 'text', text: { content: 'Client accounts, deliverables, CRM updates, and external strategic partnerships.' } }],
                    },
                },
                {
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ type: 'text', text: { content: '💼 Agency Services & Operations' } }],
                    },
                },
                {
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ type: 'text', text: { content: 'Client services, outbound pitching, client deliverables, and internal team SOPs.' } }],
                    },
                },
                {
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ type: 'text', text: { content: '📈 Capital, Finance & Corporate' } }],
                    },
                },
                {
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ type: 'text', text: { content: 'Fundraising guidelines, equity policies, legal setup, and corporate milestones.' } }],
                    },
                },
                {
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ type: 'text', text: { content: 'People & Roles' } }],
                    },
                },
                {
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ type: 'text', text: { content: 'Key members, roles, responsibilities, and team leads.' } }],
                    },
                },
                {
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ type: 'text', text: { content: 'Active Projects' } }],
                    },
                },
                {
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ type: 'text', text: { content: 'Current active initiatives, products, deliverables, and technical architecture.' } }],
                    },
                },
                {
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ type: 'text', text: { content: 'Decisions & Policies' } }],
                    },
                },
                {
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ type: 'text', text: { content: 'Formal operational and engineering decisions recorded by the team.' } }],
                    },
                },
            ],
        }));
        orgInfoPageId = page.id;
        created.orgInfo = true;
    }

    // 3. Provision "Action Items" database if not found
    if (!actionItemsDbId) {
        const db = await withRetry(() => client.databases.create({
            parent: { type: 'page_id', page_id: wikiPageId },
            title: [{ type: 'text', text: { content: 'Action Items' } }],
            icon: { type: 'emoji', emoji: '✅' },
            initial_data_source: {
                properties: {
                    Task: { title: {} },
                    Status: { status: {} },
                    Assignee: { rich_text: {} },
                    Due: { date: {} },
                },
            },
            properties: {
                Task: { title: {} },
                Status: { status: {} },
                Assignee: { rich_text: {} },
                Due: { date: {} },
            },
        }));
        actionItemsDbId = db.id;
        created.actionItems = true;
    }

    // 4. Provision "Members" database if not found
    if (!membersDbId) {
        const db = await withRetry(() => client.databases.create({
            parent: { type: 'page_id', page_id: wikiPageId },
            title: [{ type: 'text', text: { content: 'Members' } }],
            icon: { type: 'emoji', emoji: '👥' },
            initial_data_source: {
                properties: {
                    Name: { title: {} },
                    'Discord ID': { rich_text: {} },
                    Role: { rich_text: {} },
                },
            },
            properties: {
                Name: { title: {} },
                'Discord ID': { rich_text: {} },
                Role: { rich_text: {} },
            },
        }));
        membersDbId = db.id;
        created.members = true;
    }

    return {
        meetingsDbId,
        orgInfoPageId,
        actionItemsDbId,
        membersDbId,
        created,
    };
}

/**
 * Converts Markdown meeting notes into Notion blocks using @tryfabric/martian
 * and creates a new row in the Meetings database with that content as the page body.
 *
 * Honors the 100-block limit per call by appending overflow blocks.
 * Wrapped in retry-with-backoff. Degrades gracefully on failure.
 */
async function publishMeetingNotes({ token, meetingsDbId, session, markdownContent }) {
    if (!token || !meetingsDbId) {
        return { published: false, reason: 'not_configured' };
    }

    try {
        const client = getNotionClient(token);
        const blocks = markdownToBlocks(markdownContent);

        const participantsList = session.participants
            ? (session.participants instanceof Map
                ? [...session.participants.values()]
                : Array.isArray(session.participants)
                ? session.participants
                : [String(session.participants)])
            : [];

        const channelName = session.voiceChannelName || 'Voice';
        const startedDate = session.startedAt instanceof Date
            ? session.startedAt
            : new Date(session.startedAt || Date.now());
        const dateStr = startedDate.toISOString().slice(0, 10);
        const titleText = `Voice Notes — ${channelName} (${dateStr})`;

        // Notion pages.create supports up to 100 children in a single call
        const initialBlocks = blocks.slice(0, 100);
        const remainingBlocks = blocks.slice(100);

        const page = await withRetry(() => client.pages.create({
            parent: { database_id: meetingsDbId },
            icon: { type: 'emoji', emoji: '📝' },
            properties: {
                Name: {
                    title: [{ text: { content: titleText } }],
                },
                Date: {
                    date: { start: startedDate.toISOString() },
                },
                Channel: {
                    rich_text: [{ text: { content: channelName } }],
                },
                Participants: {
                    rich_text: [{
                        text: {
                            content: participantsList.length ? participantsList.join(', ') : 'None captured',
                        },
                    }],
                },
            },
            children: initialBlocks,
        }));

        // Append any remaining blocks in batches of 100
        for (let i = 0; i < remainingBlocks.length; i += 100) {
            const batch = remainingBlocks.slice(i, i + 100);
            await withRetry(() => client.blocks.children.append({
                block_id: page.id,
                children: batch,
            }));
        }

        return {
            published: true,
            pageId: page.id,
            url: page.url,
            title: titleText,
        };
    } catch (err) {
        console.error('[notion] Non-fatal failure publishing meeting notes to Notion:', err.message);
        return {
            published: false,
            error: err.message,
        };
    }
}

module.exports = {
    normalizeNotionId,
    maskToken,
    withRetry,
    getNotionClient,
    extractPageTitle,
    validateWikiPageAccess,
    getWikiPageInfo,
    findDirectChildren,
    provisionWikiStructure,
    publishMeetingNotes,
};


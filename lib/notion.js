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
 * Extracts plain text from a Notion block depending on its type.
 */
function getBlockText(block) {
    if (!block || !block.type) return '';
    const typeData = block[block.type];
    if (!typeData) return '';
    if (Array.isArray(typeData.rich_text)) {
        return typeData.rich_text.map((t) => t.plain_text || t.text?.content || '').join('');
    }
    if (Array.isArray(typeData.title)) {
        return typeData.title.map((t) => t.plain_text || t.text?.content || '').join('');
    }
    return '';
}

/**
 * Returns executive sprint banner callout blocks to augment a partially structured wiki.
 */
function getMissingSprintBannerBlocks(orgName = 'Central Wiki') {
    return [
        {
            object: 'block',
            type: 'callout',
            callout: {
                rich_text: [
                    { type: 'text', text: { content: `📢 ${orgName} Sprint Focus & Notice Board\n` }, annotations: { bold: true } },
                    { type: 'text', text: { content: '1. 🚀 Active Sprint Priorities & Key Deliverables\n2. 💼 Core Operations, Pipeline & Client Milestones\n3. 📋 Team Availability, Standups & Weekly Syncs\n\n🎯 North Star Metric: Clear operational milestone tracking for the entire team.' } },
                ],
                icon: { type: 'emoji', emoji: '⚡' },
            },
        },
        { object: 'block', type: 'divider', divider: {} },
    ];
}

const CORE_WIKI_SUBPAGES = [
    { title: 'Idea to Product Lifecycle', emoji: '💡', desc: 'Framework for taking concepts from initial brainstorming into shipping products.' },
    { title: 'Company Philosophy & Culture', emoji: '📜', desc: 'Core principles, culture, work ethics, and long-term vision.' },
    { title: 'Executive Leadership & Co-Founders', emoji: '👥', desc: 'Leadership roster, co-founder responsibilities, and key decision makers.' },
    { title: 'Term Sheet & Startup Finance', emoji: '📈', desc: 'Capital raising strategy and non-negotiable financial framework (≤5% equity dilution policy).' },
    { title: 'Pitch Deck & Investor Materials', emoji: '📑', desc: 'Executive summaries, pitch decks, cap tables, and investor communications.' },
    { title: 'Agency Services & Operations', emoji: '💼', desc: 'Client service offerings, production workflows, and delivery pipelines.' },
    { title: 'Design Assets & Brand Guidelines', emoji: '🎨', desc: 'Brand assets, typography, design guidelines, logos, and UI components.' },
    { title: 'Task Manager & Active Projects', emoji: '✅', desc: 'Operational tasks, internal milestones, and sprint deliverables.' },
    { title: 'Products & Media Lab', emoji: '🚀', desc: 'Proprietary software incubation, creative media series, and technology experiments.' },
    { title: 'Strategic Partnerships & Alliances', emoji: '🤝', desc: 'Ecosystem partners, collaboration agreements, and strategic ventures.' },
    { title: 'Client Accounts & CRM', emoji: '🎯', desc: 'Client account logs, relationship milestones, contracts, and CRM pipeline.' },
    { title: 'Public Website & Team Roster', emoji: '🌐', desc: 'Public brand presence, landing page assets, and verified team roster.' },
];

function makePageLinkOrBullet(title, subpagesMap) {
    if (subpagesMap && subpagesMap[title]) {
        return {
            object: 'block',
            type: 'link_to_page',
            link_to_page: {
                type: 'page_id',
                page_id: subpagesMap[title],
            },
        };
    }
    return {
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: title } }] },
    };
}

/**
 * Returns comprehensive multi-column executive layout blocks for a blank Central Wiki.
 * Supports linking directly to real Notion subpages and provisioned databases.
 */
function getComprehensiveWikiLayoutBlocks(orgName = 'Soren', linkedResources = {}) {
    const subpagesMap = linkedResources.subpages || {};

    const col1Children = [
        {
            object: 'block',
            type: 'heading_2',
            heading_2: { rich_text: [{ type: 'text', text: { content: '📖 Company Strategy & Philosophy' } }] },
        },
        makePageLinkOrBullet('Idea to Product Lifecycle', subpagesMap),
        makePageLinkOrBullet('Company Philosophy & Culture', subpagesMap),
        makePageLinkOrBullet('Research & Strategic Direction', subpagesMap),
        {
            object: 'block',
            type: 'heading_2',
            heading_2: { rich_text: [{ type: 'text', text: { content: '👥 Co-Founders & Leadership' } }] },
        },
        makePageLinkOrBullet('Executive Leadership & Co-Founders', subpagesMap),
        {
            object: 'block',
            type: 'heading_2',
            heading_2: { rich_text: [{ type: 'text', text: { content: '📈 Capital Raising & Finance' } }] },
        },
        {
            object: 'block',
            type: 'callout',
            callout: {
                rich_text: [
                    { type: 'text', text: { content: 'Core Policy: ' }, annotations: { bold: true } },
                    { type: 'text', text: { content: 'You do not dilute more than 5% of your company.' } },
                ],
                icon: { type: 'emoji', emoji: '💡' },
            },
        },
        makePageLinkOrBullet('Term Sheet & Startup Finance', subpagesMap),
        makePageLinkOrBullet('Pitch Deck & Investor Materials', subpagesMap),
        {
            object: 'block',
            type: 'heading_2',
            heading_2: { rich_text: [{ type: 'text', text: { content: '💼 Agency Services & Operations' } }] },
        },
        makePageLinkOrBullet('Agency Services & Operations', subpagesMap),
        {
            object: 'block',
            type: 'heading_2',
            heading_2: { rich_text: [{ type: 'text', text: { content: '🎨 Brand Assets & Projects' } }] },
        },
        makePageLinkOrBullet('Design Assets & Brand Guidelines', subpagesMap),
        makePageLinkOrBullet('Task Manager & Active Projects', subpagesMap),
    ];

    const col2Children = [
        {
            object: 'block',
            type: 'heading_2',
            heading_2: { rich_text: [{ type: 'text', text: { content: '🚀 Products & Media Lab' } }] },
        },
        makePageLinkOrBullet('Products & Media Lab', subpagesMap),
        {
            object: 'block',
            type: 'heading_2',
            heading_2: { rich_text: [{ type: 'text', text: { content: '🤝 Partnerships & Collab' } }] },
        },
        makePageLinkOrBullet('Strategic Partnerships & Alliances', subpagesMap),
        {
            object: 'block',
            type: 'heading_2',
            heading_2: { rich_text: [{ type: 'text', text: { content: '🎯 Client Accounts & CRM' } }] },
        },
        makePageLinkOrBullet('Client Accounts & CRM', subpagesMap),
        {
            object: 'block',
            type: 'heading_2',
            heading_2: { rich_text: [{ type: 'text', text: { content: '🌐 Public Website & Brand' } }] },
        },
        makePageLinkOrBullet('Public Website & Team Roster', subpagesMap),
    ];

    const blocks = [
        {
            object: 'block',
            type: 'callout',
            callout: {
                rich_text: [
                    { type: 'text', text: { content: `📢 ${orgName} Sprint Focus & Notice Board\n` }, annotations: { bold: true } },
                    { type: 'text', text: { content: '1. 🚀 Active Product Launch: Core features, release polishing, and UI themes.\n2. 💼 Services & Accounts: Outbound pitching and active client deliverables.\n3. ⚖️ Corporate & Operations: Corporate compliance, partnerships, and SOP standardization.\n4. 📋 Team Operations: Calendar availability and daily/weekly syncs.\n\n🎯 North Star Metric: Validate and scale active users/clients, and reinvest operational cashflow into proprietary tech.' } },
                ],
                icon: { type: 'emoji', emoji: '⚡' },
            },
        },
        { object: 'block', type: 'divider', divider: {} },
        {
            object: 'block',
            type: 'column_list',
            column_list: {
                children: [
                    {
                        object: 'block',
                        type: 'column',
                        column: { children: col1Children },
                    },
                    {
                        object: 'block',
                        type: 'column',
                        column: { children: col2Children },
                    },
                ],
            },
        },
        { object: 'block', type: 'divider', divider: {} },
        {
            object: 'block',
            type: 'heading_2',
            heading_2: { rich_text: [{ type: 'text', text: { content: '🗄️ Master Registries & Data Hub' } }] },
        },
        {
            object: 'block',
            type: 'callout',
            callout: {
                rich_text: [{ type: 'text', text: { content: 'Synchronized with Soren: Meetings DB, Action Items DB, Members DB, and dynamic ground truth memory are linked to this wiki hub.' } }],
                icon: { type: 'emoji', emoji: '🔗' },
            },
        },
    ];

    if (linkedResources.meetingsDbId) {
        blocks.push({
            object: 'block',
            type: 'link_to_page',
            link_to_page: { type: 'database_id', database_id: linkedResources.meetingsDbId },
        });
    }
    if (linkedResources.orgInfoPageId) {
        blocks.push({
            object: 'block',
            type: 'link_to_page',
            link_to_page: { type: 'page_id', page_id: linkedResources.orgInfoPageId },
        });
    }
    if (linkedResources.actionItemsDbId) {
        blocks.push({
            object: 'block',
            type: 'link_to_page',
            link_to_page: { type: 'database_id', database_id: linkedResources.actionItemsDbId },
        });
    }
    if (linkedResources.membersDbId) {
        blocks.push({
            object: 'block',
            type: 'link_to_page',
            link_to_page: { type: 'database_id', database_id: linkedResources.membersDbId },
        });
    }

    return blocks;
}

/**
 * Inspects a Central Wiki page and assesses its structure state:
 * - 'blank': Empty or near-empty page with <= 1 meaningful blocks.
 * - 'good_structure': Already has column layouts or sprint notice board + multiple sections.
 * - 'partial': Has some notes/headings, but lacks sprint notice board and core frameworks.
 */
async function inspectWikiStructureState(client, wikiPageId) {
    const res = await withRetry(() => client.blocks.children.list({
        block_id: wikiPageId,
        page_size: 100,
    }));
    const blocks = res.results || [];

    const meaningfulBlocks = blocks.filter((b) => {
        if (['column_list', 'child_page', 'child_database', 'divider', 'table'].includes(b.type)) return true;
        const text = getBlockText(b).trim();
        return text.length > 0;
    });

    const fullText = blocks.map((b) => getBlockText(b)).join(' ').toLowerCase();
    const hasColumnList = blocks.some((b) => b.type === 'column_list');
    const hasSprintNotice = fullText.includes('sprint') || fullText.includes('notice board');
    const headingCount = blocks.filter((b) => b.type.startsWith('heading_')).length;

    if (meaningfulBlocks.length <= 1) {
        return { state: 'blank', meaningfulCount: meaningfulBlocks.length };
    }
    if (hasColumnList || (hasSprintNotice && headingCount >= 2)) {
        return { state: 'good_structure', meaningfulCount: meaningfulBlocks.length, hasColumnList, hasSprintNotice };
    }
    return { state: 'partial', meaningfulCount: meaningfulBlocks.length, hasColumnList, hasSprintNotice };
}

/**
 * Provisions the core starter child pages under wikiPageId if they do not already exist.
 * Returns a map of title -> pageId.
 */
async function provisionCoreWikiSubpages(client, wikiPageId) {
    const subpagesMap = {};
    if (typeof client.blocks?.children?.list !== 'function' || typeof client.pages?.create !== 'function') {
        return subpagesMap;
    }

    try {
        const rootBlocks = await withRetry(() => client.blocks.children.list({ block_id: wikiPageId, page_size: 100 }));
        for (const b of (rootBlocks.results || [])) {
            if (b.type === 'child_page' && b.child_page?.title) {
                subpagesMap[b.child_page.title] = b.id;
            }
        }

        for (const sp of CORE_WIKI_SUBPAGES) {
            if (!subpagesMap[sp.title]) {
                const page = await withRetry(() => client.pages.create({
                    parent: { type: 'page_id', page_id: wikiPageId },
                    icon: { type: 'emoji', emoji: sp.emoji },
                    properties: {
                        title: [{ type: 'text', text: { content: sp.title } }],
                    },
                    children: [
                        { object: 'block', type: 'breadcrumb', breadcrumb: {} },
                        {
                            object: 'block',
                            type: 'callout',
                            callout: {
                                rich_text: [{ type: 'text', text: { content: sp.desc } }],
                                icon: { type: 'emoji', emoji: sp.emoji },
                            },
                        },
                        { object: 'block', type: 'divider', divider: {} },
                        {
                            object: 'block',
                            type: 'heading_2',
                            heading_2: { rich_text: [{ type: 'text', text: { content: 'Overview & Documentation' } }] },
                        },
                        {
                            object: 'block',
                            type: 'paragraph',
                            paragraph: {
                                rich_text: [{ type: 'text', text: { content: 'Add detailed documentation, files, or notes for this section here.' } }],
                            },
                        },
                    ],
                }));
                subpagesMap[sp.title] = page.id;
            }
        }
    } catch (err) {
        console.warn(`[notion] Warning provisioning core wiki subpages: ${err.message}`);
    }
    return subpagesMap;
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

    // Assess initial root Central Wiki page structure before provisioning child databases
    let structureState = { state: 'preserved_existing' };
    if (typeof client.blocks?.children?.append === 'function') {
        try {
            structureState = await inspectWikiStructureState(client, wikiPageId);
        } catch (analysisErr) {
            console.warn(`[notion] Warning in adaptive Central Wiki layout analysis: ${analysisErr.message}`);
        }
    }

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
                            text: { content: 'Central organization memory and dynamic ground truth for Soren. Updated from meetings and team syncs with reference to the Central Wiki.' },
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

    // Apply layout adaptation based on the initial structure state
    let layoutStatus = 'preserved_existing';
    if (typeof client.blocks?.children?.append === 'function') {
        try {
            const orgTitle = existingConfig.orgName || 'Central Wiki';

            if (structureState.state === 'blank') {
                const subpagesMap = await provisionCoreWikiSubpages(client, wikiPageId);
                await withRetry(() => client.blocks.children.append({
                    block_id: wikiPageId,
                    children: getComprehensiveWikiLayoutBlocks(orgTitle, {
                        subpages: subpagesMap,
                        meetingsDbId,
                        orgInfoPageId,
                        actionItemsDbId,
                        membersDbId,
                    }),
                }));
                layoutStatus = 'created_comprehensive';
            } else if (structureState.state === 'partial') {
                await withRetry(() => client.blocks.children.append({
                    block_id: wikiPageId,
                    children: getMissingSprintBannerBlocks(orgTitle),
                }));
                layoutStatus = 'augmented_missing_parts';
            } else {
                layoutStatus = 'preserved_existing';
            }
        } catch (analysisErr) {
            console.warn(`[notion] Warning in adaptive Central Wiki layout analysis: ${analysisErr.message}`);
        }
    }

    return {
        meetingsDbId,
        orgInfoPageId,
        actionItemsDbId,
        membersDbId,
        created,
        layoutStatus,
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

        const dateIso = startedDate.toISOString();
        const dateDisplay = dateIso.slice(0, 10);
        const titleText = `${channelName} Meeting — ${dateDisplay}`;

        const initialBlocks = blocks.slice(0, 100);
        const remainingBlocks = blocks.slice(100);

        const page = await withRetry(() => client.pages.create({
            parent: { database_id: meetingsDbId },
            properties: {
                Name: {
                    title: [{ text: { content: titleText } }],
                },
                Date: {
                    date: { start: dateIso },
                },
                Channel: {
                    rich_text: [{ text: { content: channelName } }],
                },
                Participants: {
                    rich_text: [{ text: { content: participantsList.join(', ') || 'None captured' } }],
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

/**
 * Creates an executive Soren-style Central Wiki Hub in Notion for the organization.
 * Includes top sprint notice banner, 2-column operational grid, and master registries.
 */
async function createCentralWikiHub(token, parentPageId, orgName = 'Soren', notionClient = null) {
    const client = notionClient || getNotionClient(token);

    const page = await withRetry(() => client.pages.create({
        parent: { page_id: parentPageId },
        icon: { type: 'emoji', emoji: '🏛️' },
        properties: {
            title: [{ text: { content: `${orgName} Central Wiki` } }],
        },
        children: getComprehensiveWikiLayoutBlocks(orgName),
    }));

    return page;
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
    createCentralWikiHub,
    inspectWikiStructureState,
    getComprehensiveWikiLayoutBlocks,
    getMissingSprintBannerBlocks,
};

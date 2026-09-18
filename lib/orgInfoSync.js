const { getNotionClient, withRetry } = require('./notion');
const { getGuildConfig, setGuildNotionConfig, logApiRequest } = require('./guildConfig');
const { GoogleGenAI } = require('@google/genai');

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
 * Fetches all blocks on the Org Info page and maps them by section.
 */
async function fetchOrgInfoStructure(client, orgInfoPageId) {
    const blocks = [];
    let cursor = undefined;

    do {
        const res = await withRetry(() => client.blocks.children.list({
            block_id: orgInfoPageId,
            start_cursor: cursor,
            page_size: 100,
        }));
        blocks.push(...res.results);
        cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);

    const sections = {}; // sectionName -> { headingId, headingType, items: [{ id, type, text }] }
    let currentSection = 'General';

    // Default sections
    sections['General'] = { headingId: null, headingType: null, items: [] };

    for (const block of blocks) {
        const text = getBlockText(block).trim();

        if (block.type === 'heading_1' || block.type === 'heading_2' || block.type === 'heading_3') {
            currentSection = text || 'Untitled Section';
            if (!sections[currentSection]) {
                sections[currentSection] = {
                    headingId: block.id,
                    headingType: block.type,
                    items: [],
                };
            } else {
                sections[currentSection].headingId = block.id;
                sections[currentSection].headingType = block.type;
            }
        } else if (text) {
            // Content block under the current heading
            if (!sections[currentSection]) {
                sections[currentSection] = { headingId: null, headingType: null, items: [] };
            }
            sections[currentSection].items.push({
                id: block.id,
                type: block.type,
                text,
            });
        }
    }

    // Build plain text representation for the LLM
    const plainTextLines = [];
    const sectionBlockMap = {};

    for (const [sectionName, secData] of Object.entries(sections)) {
        if (secData.headingId || secData.items.length > 0) {
            plainTextLines.push(`## ${sectionName}`);
            const itemIds = [];
            for (const item of secData.items) {
                plainTextLines.push(`* ${item.text}`);
                itemIds.push(item.id);
            }
            plainTextLines.push('');
            sectionBlockMap[sectionName] = {
                headingId: secData.headingId,
                itemBlockIds: itemIds,
            };
        }
    }

    return {
        blocks,
        sections,
        plainText: plainTextLines.join('\n').trim(),
        sectionBlockMap,
    };
}

/**
 * Fetches and formats the Central Wiki reference structure into a markdown document.
 * Recurses into column lists, columns, and toggles to preserve multi-column wiki layout.
 */
async function fetchCentralWikiMap(client, wikiPageId) {
    if (!wikiPageId || !client) return '';
    const lines = [];

    async function processBlockChildren(parentBlockId, depth = 0) {
        if (depth > 2) return;
        let cursor = undefined;
        try {
            do {
                const res = await withRetry(() => client.blocks.children.list({
                    block_id: parentBlockId,
                    start_cursor: cursor,
                    page_size: 100,
                }));
                for (const b of (res.results || [])) {
                    const text = getBlockText(b).trim();
                    const indent = '  '.repeat(depth);
                    if (b.type === 'heading_1') {
                        lines.push(`\n${indent}# ${text}`);
                    } else if (b.type === 'heading_2') {
                        lines.push(`\n${indent}## ${text}`);
                    } else if (b.type === 'heading_3') {
                        lines.push(`\n${indent}### ${text}`);
                    } else if (b.type === 'bulleted_list_item') {
                        lines.push(`${indent}* ${text}`);
                    } else if (b.type === 'numbered_list_item') {
                        lines.push(`${indent}1. ${text}`);
                    } else if (b.type === 'to_do') {
                        const checked = b.to_do?.checked ? '[x]' : '[ ]';
                        lines.push(`${indent}* ${checked} ${text}`);
                    } else if (b.type === 'callout') {
                        lines.push(`${indent}> [Notice] ${text}`);
                    } else if (b.type === 'child_page') {
                        lines.push(`${indent}📄 Page: ${b.child_page?.title || 'Untitled Page'}`);
                    } else if (b.type === 'child_database') {
                        lines.push(`${indent}🗄️ Database: ${b.child_database?.title || 'Untitled DB'}`);
                    } else if (b.type === 'paragraph' && text) {
                        lines.push(`${indent}${text}`);
                    } else if (b.type === 'toggle') {
                        lines.push(`${indent}▶ ${text}`);
                    }

                    if (b.has_children && (b.type === 'column_list' || b.type === 'column' || b.type === 'toggle')) {
                        await processBlockChildren(b.id, depth + (b.type === 'column_list' ? 0 : 1));
                    }
                }
                cursor = res.has_more ? res.next_cursor : undefined;
            } while (cursor);
        } catch (err) {
            console.warn(`[orgInfoSync] Warning fetching block children for ${parentBlockId}: ${err.message}`);
        }
    }

    try {
        await processBlockChildren(wikiPageId, 0);
        return lines.join('\n').trim();
    } catch (err) {
        console.warn(`[orgInfoSync] Failed to fetch Central Wiki map: ${err.message}`);
        return '';
    }
}

/**
 * Fetches fresh Org Info page content and/or Central Wiki reference map for context injection.
 * Non-fatal: returns an empty string on any failure or missing configuration.
 */
async function fetchOrgInfoContext(token, orgInfoPageId, wikiPageId = null, notionClient = null) {
    if (!token || (!orgInfoPageId && !wikiPageId)) return '';
    try {
        const client = notionClient || getNotionClient(token);
        const parts = [];

        // 1. If wikiPageId is provided, fetch Central Wiki Reference Map for macro navigation and ground truth
        if (wikiPageId) {
            try {
                const wikiMap = await fetchCentralWikiMap(client, wikiPageId);
                if (wikiMap) {
                    parts.push(`## CENTRAL WIKI REFERENCE & WORKSPACE MAP\n${wikiMap}`);
                }
            } catch (wikiErr) {
                console.warn(`[notion] Warning: Failed to fetch Central Wiki reference map (proceeding with Org Info): ${wikiErr.message}`);
            }
        }

        // 2. Fetch fresh dynamic Org Info structure
        if (orgInfoPageId) {
            const structure = await fetchOrgInfoStructure(client, orgInfoPageId);
            if (structure?.plainText) {
                parts.push(wikiPageId ? `## DYNAMIC ORG WORKING MEMORY & FACTS\n${structure.plainText}` : structure.plainText);
            }
        }

        return parts.join('\n\n').trim();
    } catch (err) {
        console.warn(`[notion] Warning: Failed to fetch fresh Org Info context (proceeding without it): ${err.message}`);
        return '';
    }
}

const ORG_SYNC_SYSTEM_PROMPT = `You are an organization knowledge synchronization assistant.
Your task is to review tonight's meeting notes and compare them with the current Org Info page content and Central Wiki structure.
Extract ONLY facts, decisions, people/roles, and ongoing project status updates that were EXPLICITLY stated in this meeting.

STRICT INSTRUCTIONS:
1. Output a STRICT JSON array of objects with keys: "action", "section", "content".
   [
     {
       "action": "add" | "update",
       "section": "Sprint Focus & Priorities" | "Active Products & Tech Lab" | "Clients & Partnerships" | "Agency Services & Operations" | "Capital, Finance & Corporate" | "People & Roles" | "Active Projects" | "Decisions & Policies",
       "content": "Clear statement of the fact, project update, or decision."
     }
   ]
2. "action":
   - "add": For completely new facts, projects, or decisions not already mentioned in Org Info.
   - "update": For items already on the Org Info page that were updated, altered, completed, or revised in this meeting.
3. "section": Must strictly match one of the canonical sections:
   - "Sprint Focus & Priorities": Current sprint goals, notice board announcements, sprint deadlines, North Star metrics.
   - "Active Products & Tech Lab": Proprietary products (e.g. Nori V Cam, Dogesh, AI agents), product features, UI/UX changes.
   - "Clients & Partnerships": Client accounts (e.g. Diyo, Kaapi Money), client requirements, partner deals (e.g. Crevon).
   - "Agency Services & Operations": Web development services, outbound sales, pitch deliverables, team SOPs.
   - "Capital, Finance & Corporate": Fundraising, equity dilution rules (<= 5%), term sheets, corporate setup (PAN, MSME).
   - "People & Roles": Key members, new joiners, role changes, leads.
   - "Active Projects": General cross-functional initiatives and deliverables.
   - "Decisions & Policies": Formal operational, architectural, and governance decisions.
4. CRITICAL: DO NOT infer or invent organizational structure, hierarchy, titles, or commitments that were not explicitly stated in the meeting notes.
5. If no facts, projects, or decisions in the meeting need adding or updating, return an empty array: []
6. Output RAW JSON ONLY. Do not wrap in markdown code blocks (\`\`\`json). Do not add conversational text.`;

const CANONICAL_SECTIONS = [
    'Sprint Focus & Priorities',
    'Active Products & Tech Lab',
    'Clients & Partnerships',
    'Agency Services & Operations',
    'Capital, Finance & Corporate',
    'People & Roles',
    'Active Projects',
    'Decisions & Policies',
];

function normalizeSection(rawSection) {
    if (!rawSection || typeof rawSection !== 'string') return 'Decisions & Policies';
    const clean = rawSection.trim().toLowerCase();
    // Strip path traversal characters (../, .\, etc.)
    const sanitized = clean.replace(/(\.\.|\/|\\)/g, ' ').trim();

    // Fast-path exact match
    for (const canonical of CANONICAL_SECTIONS) {
        if (sanitized === canonical.toLowerCase()) {
            return canonical;
        }
    }

    if (sanitized.includes('sprint') || sanitized.includes('notice') || sanitized.includes('priority') || sanitized.includes('priorities') || sanitized.includes('north star')) {
        return 'Sprint Focus & Priorities';
    }
    if (sanitized.includes('product') || sanitized.includes('tech lab') || sanitized.includes('cam') || sanitized.includes('extension') || sanitized.includes('dogesh')) {
        return 'Active Products & Tech Lab';
    }
    if (sanitized.includes('client') || sanitized.includes('crm') || sanitized.includes('partner') || sanitized.includes('collab') || sanitized.includes('diyo') || sanitized.includes('kaapi') || sanitized.includes('crevon')) {
        return 'Clients & Partnerships';
    }
    if (sanitized.includes('agency') || sanitized.includes('service') || sanitized.includes('outbound') || sanitized.includes('pitching')) {
        return 'Agency Services & Operations';
    }
    if (sanitized.includes('finance') || sanitized.includes('capital') || sanitized.includes('equity') || sanitized.includes('term sheet') || sanitized.includes('pitch deck') || sanitized.includes('dilut') || sanitized.includes('msme') || sanitized.includes('pan')) {
        return 'Capital, Finance & Corporate';
    }
    if (sanitized.includes('people') || sanitized.includes('role') || sanitized.includes('team') || sanitized.includes('member') || sanitized.includes('founder') || sanitized.includes('lead')) {
        return 'People & Roles';
    }
    if (sanitized.includes('project') || sanitized.includes('deliverable') || sanitized.includes('initiative')) {
        return 'Active Projects';
    }
    if (sanitized.includes('decision') || sanitized.includes('policy') || sanitized.includes('rule') || sanitized.includes('guideline') || sanitized.includes('sop')) {
        return 'Decisions & Policies';
    }
    return 'Decisions & Policies';
}

function sanitizeContent(rawText) {
    if (!rawText || typeof rawText !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    const stripped = rawText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
    return stripped.slice(0, 500);
}

/**
 * Calls Groq or Gemini to extract structured additions/updates from the meeting notes.
 */
async function extractOrgInfoUpdates({ meetingNotes, orgInfoText, provider = 'groq', groqKey, geminiKey, groqModel, geminiModel, guildId }) {
    const userPrompt = `Current Org Info Content:\n"""\n${orgInfoText || '(Empty document)'}\n"""\n\nTonight's Meeting Notes:\n"""\n${meetingNotes}\n"""`;

    let rawOutput;

    if (provider === 'gemini' && geminiKey) {
        const ai = new GoogleGenAI({ vertexai: true, apiKey: geminiKey });
        const model = geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
        const response = await ai.models.generateContent({
            model,
            contents: [
                { role: 'user', parts: [{ text: `${ORG_SYNC_SYSTEM_PROMPT}\n\n${userPrompt}` }] },
            ],
            config: {
                temperature: 0.1,
                responseMimeType: 'application/json',
            },
        });
        rawOutput = response.text || '';
        if (guildId) {
            logApiRequest({
                guildId,
                service: 'gemini_summary',
                model,
                status: 'success',
            });
        }
    } else {
        // Groq
        const apiKey = groqKey || process.env.GROQ_API_KEY;
        const model = groqModel || process.env.GROQ_SUMMARY_MODEL || 'openai/gpt-oss-120b';

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: ORG_SYNC_SYSTEM_PROMPT },
                    { role: 'user', content: userPrompt },
                ],
                temperature: 0.1,
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Groq Org Sync API error (${response.status}): ${errText}`);
        }

        const data = await response.json();
        rawOutput = data.choices?.[0]?.message?.content || '';
        if (guildId) {
            logApiRequest({
                guildId,
                service: 'groq_summary',
                model,
                status: 'success',
                tokensUsed: data.usage?.total_tokens || 0,
            });
        }
    }

    // Clean JSON formatting
    let clean = rawOutput.trim();
    if (clean.startsWith('```')) {
        clean = clean.replace(/^```(json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }

    try {
        const parsed = JSON.parse(clean);
        if (!Array.isArray(parsed)) {
            return [];
        }
        const validated = [];
        for (const item of parsed) {
            if (!item || typeof item !== 'object') continue;
            const action = item.action === 'update' ? 'update' : (item.action === 'add' ? 'add' : null);
            if (!action) continue;

            const content = sanitizeContent(item.content);
            if (!content) continue;

            const section = normalizeSection(item.section);

            validated.push({
                action,
                section,
                content,
            });
        }
        return validated;
    } catch (err) {
        console.warn('[orgInfoSync] Could not parse LLM output as JSON:', clean.slice(0, 200), err.message);
        return [];
    }
}

/**
 * Matches an update against existing items under a section using term overlap.
 */
function findMatchingItem(existingItems, updateContent) {
    if (!existingItems || existingItems.length === 0 || !updateContent) return null;

    const words = updateContent.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    if (words.length === 0) return null;

    let bestMatch = null;
    let maxMatches = 0;
    let ties = 0;

    for (const item of existingItems) {
        const itemText = item.text.toLowerCase();
        let matches = 0;
        for (const w of words) {
            if (itemText.includes(w)) matches++;
        }
        if (matches > maxMatches) {
            maxMatches = matches;
            bestMatch = item;
            ties = 0;
        } else if (matches === maxMatches && matches > 0) {
            ties++;
        }
    }

    // Require at least 2 distinct word matches and an unambiguous winner
    return (maxMatches >= 2 && ties === 0) ? bestMatch : null;
}

/**
 * Applies targeted block patches to the Org Info page without rewriting the whole page.
 * Never falls back to page root on missing anchors or ambiguous updates.
 */
async function applyOrgInfoPatch(client, orgInfoPageId, sections, updates) {
    const patches = [];
    let addedCount = 0;
    let updatedCount = 0;

    for (const update of updates) {
        const targetSectionName = Object.keys(sections).find(
            (s) => s.toLowerCase().includes(update.section.toLowerCase()) || update.section.toLowerCase().includes(s.toLowerCase())
        ) || update.section;

        const secData = sections[targetSectionName] || sections['Decisions & Policies'];
        if (!secData) {
            console.warn(`[orgInfoSync] Unknown section '${targetSectionName}', skipping patch safely.`);
            continue;
        }

        if (update.action === 'update') {
            const matchedItem = findMatchingItem(secData.items, update.content);

            if (!matchedItem) {
                // Ambiguous or no match: NEVER guess and NEVER overwrite an unrelated block.
                console.warn(`[orgInfoSync] Update for section '${targetSectionName}' could not be uniquely matched. Skipping to preserve data integrity.`);
                patches.push({ action: 'update', status: 'skipped', reason: 'unmatched_or_ambiguous', section: targetSectionName, content: update.content });
                continue;
            }

            try {
                const blockType = matchedItem.type || 'bulleted_list_item';
                await withRetry(() => client.blocks.update({
                    block_id: matchedItem.id,
                    [blockType]: {
                        rich_text: [{ type: 'text', text: { content: update.content } }],
                    },
                }));
                matchedItem.text = update.content;
                updatedCount++;
                patches.push({ action: 'update', status: 'applied', section: targetSectionName, blockId: matchedItem.id, content: update.content });
                continue;
            } catch (updateErr) {
                // Do NOT fall back to append. Fail safely and log.
                console.warn(`[orgInfoSync] Block update failed for ${matchedItem.id}:`, updateErr.message);
                patches.push({ action: 'update', status: 'failed', reason: updateErr.message, section: targetSectionName, blockId: matchedItem.id });
                continue;
            }
        }

        // Action === 'add'
        if (update.action === 'add') {
            let anchorId = secData.items.length > 0
                ? secData.items[secData.items.length - 1].id
                : secData.headingId;

            let added = false;

            if (anchorId) {
                try {
                    const appendRes = await withRetry(() => client.blocks.children.append({
                        block_id: orgInfoPageId,
                        after: anchorId,
                        children: [{
                            object: 'block',
                            type: 'bulleted_list_item',
                            bulleted_list_item: {
                                rich_text: [{ type: 'text', text: { content: update.content } }],
                            },
                        }],
                    }));

                    const newBlockId = appendRes.results?.[0]?.id;
                    if (newBlockId) {
                        secData.items.push({ id: newBlockId, type: 'bulleted_list_item', text: update.content });
                    }
                    added = true;
                } catch (appendErr) {
                    console.warn(`[orgInfoSync] Append after anchor ${anchorId} failed, attempting single re-fetch recovery:`, appendErr.message);
                }
            }

            // If anchor was missing or append failed, re-fetch structure once to rebuild section anchors
            if (!added) {
                try {
                    const fresh = await fetchOrgInfoStructure(client, orgInfoPageId);
                    const freshSec = fresh.sections[targetSectionName] || fresh.sections['Decisions & Policies'];
                    if (freshSec) {
                        anchorId = freshSec.items.length > 0
                            ? freshSec.items[freshSec.items.length - 1].id
                            : freshSec.headingId;

                        if (anchorId) {
                            const appendRes = await withRetry(() => client.blocks.children.append({
                                block_id: orgInfoPageId,
                                after: anchorId,
                                children: [{
                                    object: 'block',
                                    type: 'bulleted_list_item',
                                    bulleted_list_item: {
                                        rich_text: [{ type: 'text', text: { content: update.content } }],
                                    },
                                }],
                            }));

                            const newBlockId = appendRes.results?.[0]?.id;
                            if (newBlockId) {
                                secData.items.push({ id: newBlockId, type: 'bulleted_list_item', text: update.content });
                            }
                            added = true;
                        }
                    }
                } catch (recoveryErr) {
                    console.warn(`[orgInfoSync] Anchor re-fetch recovery failed:`, recoveryErr.message);
                }
            }

            // CRITICAL: If still not added, DO NOT append to root!
            // Skip the patch safely to prevent silent corruption outside of sections.
            if (added) {
                addedCount++;
                patches.push({ action: 'add', status: 'applied', section: targetSectionName, content: update.content });
            } else {
                console.warn(`[orgInfoSync] Section anchor for '${targetSectionName}' unavailable. Patch safely skipped without root append.`);
                patches.push({ action: 'add', status: 'skipped', reason: 'anchor_unavailable', section: targetSectionName, content: update.content });
            }
        }
    }

    // Return updated sectionBlockMap
    const updatedMap = {};
    for (const [secName, sec] of Object.entries(sections)) {
        updatedMap[secName] = {
            headingId: sec.headingId,
            itemBlockIds: sec.items.map((i) => i.id),
        };
    }

    return {
        patches,
        addedCount,
        updatedCount,
        sectionBlockMap: updatedMap,
    };
}

// In-process per-guild locks to prevent concurrent sync races
const guildLocks = new Map();

async function withGuildLock(guildId, fn) {
    const prev = guildLocks.get(guildId) || Promise.resolve();
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    guildLocks.set(guildId, prev.then(() => next, () => next));
    try {
        await prev;
        return await fn();
    } finally {
        release();
        if (guildLocks.get(guildId) === next) {
            guildLocks.delete(guildId);
        }
    }
}

/**
 * Orchestrates fetching current Org Info, running LLM extraction, and applying targeted patches.
 * Serialized per guild to prevent concurrent patch overwrites.
 */
async function syncOrgInfoForGuild({ guildId, meetingNotes, force = false }) {
    return withGuildLock(guildId, async () => {
        const config = getGuildConfig(guildId);

        if (!config.notionToken || !config.orgInfoPageId) {
            return { success: false, reason: 'notion_not_configured' };
        }

        const syncMode = config.syncMode || 'manual';
        if (!force && syncMode !== 'automatic') {
            return { success: false, skipped: true, syncMode: 'manual' };
        }

        const client = getNotionClient(config.notionToken);

        // 1. Fetch fresh Org Info structure
        const { sections, plainText } = await fetchOrgInfoStructure(client, config.orgInfoPageId);

        // Ground with Central Wiki reference if wikiPageId is configured
        let wikiContext = '';
        if (config.wikiPageId) {
            try {
                wikiContext = await fetchCentralWikiMap(client, config.wikiPageId);
            } catch (wikiErr) {
                console.warn(`[orgInfoSync] Warning fetching wiki map: ${wikiErr.message}`);
            }
        }

        const orgInfoTextForLlm = wikiContext
            ? `Central Wiki Workspace Reference:\n${wikiContext}\n\nCurrent Living Org Info Memory:\n${plainText}`
            : plainText;

        // 2. Run LLM extraction call
        const updates = await extractOrgInfoUpdates({
            meetingNotes,
            orgInfoText: orgInfoTextForLlm,
            provider: config.summaryProvider || 'groq',
            groqKey: config.groqApiKey,
            geminiKey: config.geminiApiKey,
            groqModel: config.groqModel,
            geminiModel: config.geminiModel,
            guildId,
        });

        if (!updates || updates.length === 0) {
            return {
                success: true,
                applied: 0,
                addedCount: 0,
                updatedCount: 0,
                patches: [],
                orgInfoPageId: config.orgInfoPageId,
                message: 'No new organizational facts or decisions required syncing.',
            };
        }

        // 3. Apply targeted block patches
        const patchResult = await applyOrgInfoPatch(client, config.orgInfoPageId, sections, updates);

        // 4. Update section block map in guild config
        setGuildNotionConfig(guildId, {
            sectionBlockMap: patchResult.sectionBlockMap,
        });

        return {
            success: true,
            applied: patchResult.patches.length,
            addedCount: patchResult.addedCount,
            updatedCount: patchResult.updatedCount,
            patches: patchResult.patches,
            orgInfoPageId: config.orgInfoPageId,
        };
    });
}

module.exports = {
    fetchCentralWikiMap,
    fetchOrgInfoStructure,
    fetchOrgInfoContext,
    extractOrgInfoUpdates,
    applyOrgInfoPatch,
    syncOrgInfoForGuild,
    withGuildLock,
    CANONICAL_SECTIONS,
    normalizeSection,
    sanitizeContent,
};

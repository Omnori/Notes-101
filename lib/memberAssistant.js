const { getNotionClient, withRetry } = require('./notion');
const { logAudit } = require('./guildConfig');
const { executeGroqRequest } = require('./groqRateLimiter');
const { GoogleGenAI } = require('@google/genai');

/**
 * Extracts plain text from a Notion block.
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
 * Universal database query supporting both Notion Client v5 (dataSources.query) and legacy databases.query.
 */
async function queryDatabase(client, databaseId, filter = null, pageSize = 25) {
    if (!client || !databaseId) return { results: [] };
    try {
        let dataSourceId = databaseId;
        if (client.dataSources && client.dataSources.query) {
            try {
                const dbInfo = await withRetry(() => client.databases.retrieve({ database_id: databaseId }));
                if (dbInfo.data_sources && dbInfo.data_sources.length > 0) {
                    dataSourceId = dbInfo.data_sources[0].id;
                }
            } catch {
                // Ignore and use databaseId directly
            }
            const queryParams = { data_source_id: dataSourceId, page_size: pageSize };
            if (filter) queryParams.filter = filter;
            return await withRetry(() => client.dataSources.query(queryParams));
        } else if (client.databases && client.databases.query) {
            const queryParams = { database_id: databaseId, page_size: pageSize };
            if (filter) queryParams.filter = filter;
            return await withRetry(() => client.databases.query(queryParams));
        }
    } catch (err) {
        console.warn(`[notion] Query failed for database ${databaseId}:`, err.message);
        return { results: [] };
    }
    return { results: [] };
}

/**
 * Finds or creates a personal member page in the Members database.
 * Ignores trashed or archived pages.
 */
async function getOrCreateMemberPage(client, membersDbId, { discordUserId, username, displayName, role = 'Member' }) {
    if (!membersDbId) return null;

    const nameToMatch = displayName || username || 'Team Member';

    // 1. Authoritative lookup: strictly by Discord ID
    if (discordUserId) {
        try {
            const queryRes = await queryDatabase(client, membersDbId, {
                property: 'Discord ID',
                rich_text: {
                    equals: String(discordUserId),
                },
            }, 5);

            if (queryRes.results && queryRes.results.length > 0) {
                const page = queryRes.results.find((p) => !p.in_trash && !p.archived);
                if (page) {
                    const currentTitle = page.properties?.Name?.title?.[0]?.plain_text || '';
                    // If user updated their username or display name, sync Notion title to maintain consistency
                    if (currentTitle && currentTitle !== nameToMatch) {
                        try {
                            await withRetry(() => client.pages.update({
                                page_id: page.id,
                                properties: {
                                    Name: {
                                        title: [{ text: { content: nameToMatch } }],
                                    },
                                },
                            }));
                        } catch (updateErr) {
                            console.warn(`[notion:members] Non-fatal failure syncing member title rename:`, updateErr.message);
                        }
                    }

                    return {
                        pageId: page.id,
                        url: page.url,
                        name: nameToMatch,
                        role: page.properties?.Role?.rich_text?.[0]?.plain_text || role,
                        created: false,
                    };
                }
            }
        } catch (queryErr) {
            console.warn(`[notion:members] Error querying member by Discord ID:`, queryErr.message);
        }
    } else {
        // Fallback to Name lookup ONLY when discordUserId is not provided (e.g. legacy external records)
        try {
            const queryRes = await queryDatabase(client, membersDbId, {
                property: 'Name',
                title: {
                    equals: nameToMatch,
                },
            }, 5);

            if (queryRes.results && queryRes.results.length > 0) {
                const page = queryRes.results.find((p) => !p.in_trash && !p.archived);
                if (page) {
                    return {
                        pageId: page.id,
                        url: page.url,
                        name: page.properties?.Name?.title?.[0]?.plain_text || nameToMatch,
                        role: page.properties?.Role?.rich_text?.[0]?.plain_text || role,
                        created: false,
                    };
                }
            }
        } catch {
            // Continue to create
        }
    }

    // 2. Create a new personal member page with starter sections
    try {
        const newPage = await withRetry(() => client.pages.create({
            parent: { database_id: membersDbId },
            icon: { type: 'emoji', emoji: '👤' },
            properties: {
                Name: {
                    title: [{ text: { content: nameToMatch } }],
                },
                'Discord ID': {
                    rich_text: [{ text: { content: String(discordUserId || '') } }],
                },
                Role: {
                    rich_text: [{ text: { content: role } }],
                },
            },
            children: [
                {
                    object: 'block',
                    type: 'callout',
                    callout: {
                        rich_text: [{
                            type: 'text',
                            text: { content: `Personal workspace page and active tasks for ${nameToMatch} (Discord: <@${discordUserId}>).` },
                        }],
                        icon: { type: 'emoji', emoji: '📌' },
                    },
                },
                {
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ type: 'text', text: { content: 'Assigned Tasks & Action Items' } }],
                    },
                },
                {
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ type: 'text', text: { content: 'No pending tasks assigned.' } }],
                    },
                },
                {
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ type: 'text', text: { content: 'Personal Notes & Working Details' } }],
                    },
                },
                {
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ type: 'text', text: { content: 'Working notes and project details recorded from meetings.' } }],
                    },
                },
            ],
        }));

        return {
            pageId: newPage.id,
            url: newPage.url,
            name: nameToMatch,
            role,
            created: true,
        };
    } catch (err) {
        console.warn(`[notion:members] Non-fatal failure creating member page for ${nameToMatch}:`, err.message);
        return null;
    }
}

/**
 * Fetches the plain text contents of a member's personal page.
 */
async function fetchMemberPersonalNotes(client, memberPageId) {
    if (!memberPageId) return '';
    try {
        const blocksRes = await withRetry(() => client.blocks.children.list({
            block_id: memberPageId,
            page_size: 100,
        }));

        const lines = [];
        for (const block of blocksRes.results) {
            if (block.in_trash || block.archived) continue;
            const text = getBlockText(block).trim();
            if (!text) continue;

            if (block.type.startsWith('heading_')) {
                lines.push(`\n### ${text}`);
            } else if (block.type === 'to_do') {
                const checked = block.to_do?.checked ? '[x]' : '[ ]';
                lines.push(`* ${checked} ${text}`);
            } else if (block.type === 'bulleted_list_item') {
                lines.push(`* ${text}`);
            } else {
                lines.push(text);
            }
        }
        return lines.join('\n').trim();
    } catch (err) {
        console.warn(`[notion:members] Non-fatal error fetching member page blocks:`, err.message);
        return '';
    }
}

/**
 * Appends a personal note to the member's personal page in Notion.
 */
async function appendMemberPersonalNote(client, memberPageId, noteText) {
    if (!memberPageId || !noteText) return false;
    try {
        const today = new Date().toISOString().slice(0, 10);
        await withRetry(() => client.blocks.children.append({
            block_id: memberPageId,
            children: [
                {
                    object: 'block',
                    type: 'bulleted_list_item',
                    bulleted_list_item: {
                        rich_text: [{
                            type: 'text',
                            text: { content: `[${today}] ${noteText.trim()}` },
                        }],
                    },
                },
            ],
        }));
        return true;
    } catch (err) {
        console.warn(`[notion:members] Non-fatal failure appending note to page ${memberPageId}:`, err.message);
        return false;
    }
}

/**
 * Fetches Action Items from the Action Items database.
 */
async function fetchActionItems(client, actionItemsDbId, { assignee = null, limit = 25 } = {}) {
    if (!actionItemsDbId) return [];
    try {
        let filter = null;
        if (assignee) {
            filter = {
                property: 'Assignee',
                rich_text: {
                    contains: assignee,
                },
            };
        }

        const res = await queryDatabase(client, actionItemsDbId, filter, limit);
        const items = [];

        for (const page of (res.results || [])) {
            const task = page.properties?.Task?.title?.[0]?.plain_text || 'Untitled Task';
            const status = page.properties?.Status?.status?.name || page.properties?.Status?.select?.name || 'Not started';
            const itemAssignee = page.properties?.Assignee?.rich_text?.[0]?.plain_text || 'Unassigned';
            const due = page.properties?.Due?.date?.start || null;

            items.push({
                id: page.id,
                url: page.url,
                task,
                status,
                assignee: itemAssignee,
                due,
            });
        }
        return items;
    } catch (err) {
        console.warn(`[notion:actionItems] Non-fatal failure fetching action items:`, err.message);
        return [];
    }
}

/**
 * Creates a new action item in the Action Items database.
 */
async function createActionItem(client, actionItemsDbId, { task, assignee = 'Unassigned', due = null, status = 'Not started' }) {
    if (!actionItemsDbId || !task) return null;
    try {
        const properties = {
            Task: {
                title: [{ text: { content: task } }],
            },
            Assignee: {
                rich_text: [{ text: { content: assignee } }],
            },
        };

        if (due) {
            properties.Due = {
                date: { start: due },
            };
        }

        // Try status, or fallback without status if database uses select
        properties.Status = {
            status: { name: status },
        };

        let page;
        try {
            page = await withRetry(() => client.pages.create({
                parent: { database_id: actionItemsDbId },
                properties,
            }));
        } catch {
            // If status property failed (e.g. database has select property instead of status)
            delete properties.Status;
            page = await withRetry(() => client.pages.create({
                parent: { database_id: actionItemsDbId },
                properties,
            }));
        }

        return {
            id: page.id,
            url: page.url,
            task,
            assignee,
            due,
        };
    } catch (err) {
        console.warn(`[notion:actionItems] Non-fatal failure creating action item:`, err.message);
        return null;
    }
}

/**
 * Updates the status of an existing action item in Notion.
 */
async function updateActionItemStatus(client, actionItemId, newStatus = 'Done') {
    if (!actionItemId) return false;
    try {
        try {
            await withRetry(() => client.pages.update({
                page_id: actionItemId,
                properties: {
                    Status: {
                        status: { name: newStatus },
                    },
                },
            }));
            return true;
        } catch {
            await withRetry(() => client.pages.update({
                page_id: actionItemId,
                properties: {
                    Status: {
                        select: { name: newStatus },
                    },
                },
            }));
            return true;
        }
    } catch (err) {
        console.warn(`[notion:actionItems] Non-fatal error updating action item ${actionItemId}:`, err.message);
        return false;
    }
}

/**
 * Extracts action items and per-speaker working details from meeting notes markdown.
 */
function parseMeetingActionItemsAndWorkingDetails(meetingNotes) {
    const actionItems = [];
    const workingDetails = []; // [{ speaker, details }]

    if (!meetingNotes) return { actionItems, workingDetails };

    // 1. Extract action items: `* [ ] **[Task]** - @[Owner] (Due: [Due])`
    const actionItemRegex = /\*\s*\[\s*\]\s*\*\*([^*]+)\*\*\s*(?:–|-)\s*@?([^(]+)(?:\((?:Due:\s*)?([^)]+)\))?/gi;
    let match;
    while ((match = actionItemRegex.exec(meetingNotes)) !== null) {
        const task = (match[1] || '').trim();
        let owner = (match[2] || '').trim();
        let due = (match[3] || '').trim();

        if (owner.startsWith('@')) owner = owner.slice(1).trim();
        if (due.toLowerCase().includes('not specified') || !due) due = null;

        if (task) {
            actionItems.push({ task, owner: owner || 'Unassigned', due });
        }
    }

    // 2. Extract key discussion points per speaker: `* [Speaker Name]: [Point]`
    const keyPointsSectionMatch = meetingNotes.match(/## Key Discussion Points([\s\S]*?)(?:##|$)/i);
    if (keyPointsSectionMatch) {
        const pointsText = keyPointsSectionMatch[1];
        const speakerLineRegex = /^\s*\*\s*(?:\*\*)?([^:*]+)(?:\*\*)?:\s*(.+)$/gm;
        let pMatch;
        while ((pMatch = speakerLineRegex.exec(pointsText)) !== null) {
            const speaker = (pMatch[1] || '').trim();
            const details = (pMatch[2] || '').trim();
            if (speaker && details) {
                workingDetails.push({ speaker, details });
            }
        }
    }

    return { actionItems, workingDetails };
}

/**
 * Organises tasks and working details into Action Items DB and Members' personal pages.
 */
async function syncMeetingTasksAndPersonalNotes({ client, actionItemsDbId, membersDbId, meetingNotes, participants = new Map(), session = {} }) {
    if (!meetingNotes) {
        return { tasksCreated: 0, membersUpdated: 0 };
    }

    const { actionItems, workingDetails } = parseMeetingActionItemsAndWorkingDetails(meetingNotes);
    let tasksCreated = 0;
    const updatedMemberPages = new Set();

    // Map of name -> discordUserId if available
    const participantNameMap = new Map();
    if (participants instanceof Map) {
        for (const [userId, name] of participants.entries()) {
            participantNameMap.set(name.toLowerCase().trim(), userId);
        }
    }

    // 1. Create items in Action Items DB
    if (actionItemsDbId && actionItems.length > 0) {
        for (const item of actionItems) {
            const created = await createActionItem(client, actionItemsDbId, {
                task: item.task,
                assignee: item.owner,
                due: item.due,
            });
            if (created) tasksCreated++;
        }
    }

    // 2. Organise personal notes and tasks in each Member's personal page
    if (membersDbId) {
        const ownerTasksMap = new Map(); // ownerName -> tasks[]
        for (const item of actionItems) {
            const ownerKey = item.owner.toLowerCase().trim();
            if (ownerKey === 'unassigned') continue;
            if (!ownerTasksMap.has(ownerKey)) ownerTasksMap.set(ownerKey, []);
            ownerTasksMap.get(ownerKey).push(item);
        }

        const ownerWorkingDetailsMap = new Map(); // speakerName -> details[]
        for (const wd of workingDetails) {
            const speakerKey = wd.speaker.toLowerCase().trim();
            if (!ownerWorkingDetailsMap.has(speakerKey)) ownerWorkingDetailsMap.set(speakerKey, []);
            ownerWorkingDetailsMap.get(speakerKey).push(wd.details);
        }

        const allMemberNames = new Set([...ownerTasksMap.keys(), ...ownerWorkingDetailsMap.keys()]);

        for (const nameKey of allMemberNames) {
            const discordUserId = participantNameMap.get(nameKey) || null;
            const displayName = [...(participants.values ? participants.values() : [])].find(
                (n) => n.toLowerCase().trim() === nameKey,
            ) || nameKey;

            const memberPage = await getOrCreateMemberPage(client, membersDbId, {
                discordUserId,
                displayName,
                username: displayName,
            });

            if (memberPage && memberPage.pageId) {
                const blocksToAppend = [];
                const meetingDate = session.startedAt instanceof Date
                    ? session.startedAt.toISOString().slice(0, 10)
                    : new Date().toISOString().slice(0, 10);
                const channelName = session.voiceChannelName || 'Voice Meeting';

                const assigned = ownerTasksMap.get(nameKey) || [];
                if (assigned.length > 0) {
                    blocksToAppend.push({
                        object: 'block',
                        type: 'paragraph',
                        paragraph: {
                            rich_text: [{
                                type: 'text',
                                text: { content: `📅 From Meeting: ${channelName} (${meetingDate}):` },
                                annotations: { bold: true },
                            }],
                        },
                    });

                    for (const t of assigned) {
                        const dueText = t.due ? ` (Due: ${t.due})` : '';
                        blocksToAppend.push({
                            object: 'block',
                            type: 'to_do',
                            to_do: {
                                rich_text: [{ type: 'text', text: { content: `${t.task}${dueText}` } }],
                                checked: false,
                            },
                        });
                    }
                }

                const details = ownerWorkingDetailsMap.get(nameKey) || [];
                if (details.length > 0) {
                    for (const d of details) {
                        blocksToAppend.push({
                            object: 'block',
                            type: 'bulleted_list_item',
                            bulleted_list_item: {
                                rich_text: [{ type: 'text', text: { content: `[${meetingDate}] ${d}` } }],
                            },
                        });
                    }
                }

                if (blocksToAppend.length > 0) {
                    try {
                        await withRetry(() => client.blocks.children.append({
                            block_id: memberPage.pageId,
                            children: blocksToAppend,
                        }));
                        updatedMemberPages.add(memberPage.pageId);
                    } catch (err) {
                        console.warn(`[notion:members] Non-fatal error appending blocks to member page:`, err.message);
                    }
                }
            }
        }
    }

    return {
        tasksCreated,
        membersUpdated: updatedMemberPages.size,
    };
}

/**
 * Grounded Assistant Q&A Engine with Strict User-Scoped Resolution.
 */
async function askGroundedAssistant({
    question,
    callerUser,
    targetMember,
    guildConfig,
    recentMeetings = [],
    orgInfoText = '',
    provider = 'groq',
    apiKey,
    model,
    guildId,
    notionClient = null,
}) {
    const client = notionClient || (guildConfig.notionToken ? getNotionClient(guildConfig.notionToken) : null);
    let personalNotesText = '';
    let actionItemsList = [];

    const effectiveTargetUser = targetMember || callerUser;
    const targetDisplayName = effectiveTargetUser.displayName || effectiveTargetUser.username;

    // 1. Fetch target member's personal page notes if Members DB is provisioned
    if (client && guildConfig.membersDbId) {
        try {
            const memberPage = await getOrCreateMemberPage(client, guildConfig.membersDbId, {
                discordUserId: effectiveTargetUser.id,
                username: effectiveTargetUser.username,
                displayName: targetDisplayName,
            });
            if (memberPage && memberPage.pageId) {
                personalNotesText = await fetchMemberPersonalNotes(client, memberPage.pageId);
            }
        } catch (err) {
            console.warn(`[assistant] Non-fatal failure fetching personal notes for ${targetDisplayName}:`, err.message);
        }
    }

    // 2. Fetch action items strictly scoped to target member
    if (client && guildConfig.actionItemsDbId) {
        try {
            actionItemsList = await fetchActionItems(client, guildConfig.actionItemsDbId, {
                assignee: targetDisplayName,
                limit: 15,
            });
        } catch (err) {
            console.warn(`[assistant] Non-fatal failure fetching action items:`, err.message);
        }
    }

    // 3. Format meeting history
    const meetingsFormatted = recentMeetings.map((m) => {
        const dateStr = m.started_at ? String(m.started_at).slice(0, 10) : 'Recent';
        return `### Meeting: ${m.channel_name || 'Voice'} (${dateStr})\n${m.summary_text || 'No summary text recorded.'}`;
    }).join('\n\n');

    // 4. Format Action Items
    const actionItemsFormatted = actionItemsList.length > 0
        ? actionItemsList.map((a) => `* [Status: ${a.status}] "${a.task}" - Assigned to: @${a.assignee}${a.due ? ` (Due: ${a.due})` : ''} [ID: ${a.id}]`).join('\n')
        : 'No active action items found in Notion.';

    // 5. Build allowed citations and prompt
    const allowedCitations = [];
    if (orgInfoText) {
        allowedCitations.push('- "[Central Wiki: <Section>]"');
        allowedCitations.push('- "[Org Info: <Section>]"');
    }
    if (recentMeetings && recentMeetings.length > 0) allowedCitations.push('- "[Meeting: <Date/Channel>]"');
    if (actionItemsList.length > 0) allowedCitations.push('- "[Action Items DB]"');
    if (personalNotesText) allowedCitations.push(`- "[Personal Notes for @${targetDisplayName}]"`);

    const citationsInstructions = allowedCitations.length > 0
        ? `2. You may cite sources ONLY from the following allowed list:\n${allowedCitations.join('\n')}\n   DO NOT invent or hallucinate any other citation sources (e.g. do not invent HR documents, emails, or unspecified private pages).`
        : '2. No external knowledge bases were retrieved. Do not include any source citations.';

    const SYSTEM_PROMPT = `You are Notes 101 AI Assistant, dedicated to this Discord server and strictly grounded in the server's Notion Wiki, meeting history, and member records.

STRICT GROUNDING & ANTI-HALLUCINATION POLICY:
1. Answer the user's question using ONLY the provided Organizational Context, Recent Meetings, Action Items, and Personal Notes.
${citationsInstructions}
3. If an answer cannot be determined from the provided context, state clearly and concisely: "I couldn't find information about that in the server's Notion wiki or personal records." NEVER make up deadlines, tasks, or facts.
4. Keep answers clear, structured, and helpful.`;

    const userPromptContent = `[Query Context: Target Member @${targetDisplayName} (Discord ID: ${effectiveTargetUser.id})]

--- Organizational Context (Central Wiki & Org Info) ---
${orgInfoText || 'No Org Info configured.'}

--- Recent Meetings ---
${meetingsFormatted || 'No past meetings recorded.'}

--- Action Items in Notion ---
${actionItemsFormatted}

--- Personal Notes for @${targetDisplayName} ---
${personalNotesText || 'No personal notes recorded yet.'}

--- User Question ---
${question}`;

    let answer;

    if (provider === 'gemini' && apiKey) {
        const ai = new GoogleGenAI({ vertexai: true, apiKey });
        const selectedModel = model || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
        const response = await ai.models.generateContent({
            model: selectedModel,
            contents: [
                { role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\n${userPromptContent}` }] },
            ],
        });
        answer = response.text || '';
    } else {
        const effectiveGroqKey = apiKey || process.env.GROQ_API_KEY;
        const selectedModel = model || process.env.GROQ_SUMMARY_MODEL || 'openai/gpt-oss-120b';
        const estimatedTokens = Math.ceil(userPromptContent.length / 4) + 600;

        const groqRes = await executeGroqRequest(async () => {
            const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${effectiveGroqKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: selectedModel,
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: userPromptContent },
                    ],
                    temperature: 0.2,
                }),
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Groq Q&A API error (${res.status}): ${errText}`);
            }

            const data = await res.json();
            return data.choices?.[0]?.message?.content || '';
        }, { apiKey: effectiveGroqKey, estimatedTokens, guildId });

        answer = groqRes;
    }

    // Post-process citations to remove any hallucinated citation sources
    if (typeof answer === 'string') {
        if (!personalNotesText) {
            answer = answer.replace(/\[Personal Notes[^\]]*\]/gi, '');
        }
        if (!orgInfoText) {
            answer = answer.replace(/\[Org Info[^\]]*\]/gi, '');
        }
        if (actionItemsList.length === 0) {
            answer = answer.replace(/\[Action Items DB\]/gi, '');
        }
        if (!recentMeetings || recentMeetings.length === 0) {
            answer = answer.replace(/\[Meeting[^\]]*\]/gi, '');
        }
        // Disallow arbitrary invented tags (e.g. [Private HR Document])
        answer = answer.replace(/\[(?!Org Info|Meeting|Action Items DB|Personal Notes)[^\]]{3,40}\]/gi, '');
    }

    return {
        answer: answer.trim(),
        targetDisplayName,
        targetUserId: effectiveTargetUser.id,
        actionItemsCount: actionItemsList.length,
    };
}

/**
 * Handles follow-up messages during the 2-minute collector window:
 * Detects exit commands, personal note additions, task completions/updates, or conversational follow-up questions.
 */
async function handleFollowUpInteraction({
    userMessage,
    callerUser,
    targetMember,
    guildConfig,
    recentMeetings = [],
    orgInfoText = '',
    provider = 'groq',
    apiKey,
    model,
    guildId,
    isAdmin = false,
    notionClient = null,
}) {
    const raw = userMessage.trim();
    const lower = raw.toLowerCase();

    // 1. Exit commands
    if (['done', 'stop', 'exit', 'cancel', 'bye', 'close'].includes(lower)) {
        return {
            type: 'exit',
            message: '👋 Q&A session closed. You can start a new query anytime with `/notes ask`.',
        };
    }

    const client = notionClient || (guildConfig.notionToken ? getNotionClient(guildConfig.notionToken) : null);
    const effectiveTargetUser = targetMember || callerUser;
    const targetDisplayName = effectiveTargetUser.displayName || effectiveTargetUser.username;

    // 2. Personal note addition command
    // Patterns: "add note: ...", "note: ...", "add to my notes: ...", "remember: ..."
    const notePrefixRegex = /^(?:add\s+note(?:\s*to\s*(?:my|personal)\s*notes)?|note|remember(?:\s+that)?|add\s+personal\s+note):\s*(.+)$/i;
    const noteMatch = raw.match(notePrefixRegex);
    if (noteMatch && noteMatch[1]) {
        // Authorization check: non-admins cannot write to other members' personal notes
        if (!isAdmin && effectiveTargetUser.id !== callerUser.id) {
            return {
                type: 'forbidden',
                message: '⛔ **Permission Denied:** Only administrators can add notes to another member\'s personal records.',
            };
        }

        const noteText = noteMatch[1].trim();
        if (client && guildConfig.membersDbId) {
            const memberPage = await getOrCreateMemberPage(client, guildConfig.membersDbId, {
                discordUserId: effectiveTargetUser.id,
                username: effectiveTargetUser.username,
                displayName: targetDisplayName,
            });
            if (memberPage?.pageId) {
                const success = await appendMemberPersonalNote(client, memberPage.pageId, noteText);
                if (success) {
                    logAudit({
                        guildId,
                        userId: callerUser.id,
                        userTag: callerUser.tag || callerUser.username,
                        action: 'personal_note_added',
                        targetMemberId: effectiveTargetUser.id,
                        details: noteText,
                    });
                    return {
                        type: 'note_added',
                        message: `📝 **Added to personal notes for @${targetDisplayName}:**\n> "${noteText}"\n🔗 [Open Member Page in Notion](${memberPage.url})`,
                    };
                }
            }
        }
        return {
            type: 'error',
            message: '⚠️ Could not save personal note because Notion Members DB is not configured or reachable.',
        };
    }

    // 3. Task update command
    // Patterns: "mark task <name> as done", "completed task <name>", "finish task <name>"
    const taskUpdateRegex = /^(?:mark(?:\s+task)?\s+["']?(.+?)["']?\s+as\s+(done|completed|in progress|not started)|(?:finish|complete)\s+(?:task\s+)?["']?(.+?)["']?)$/i;
    const taskMatch = raw.match(taskUpdateRegex);
    if (taskMatch) {
        const queryTerm = (taskMatch[1] || taskMatch[3] || '').trim();
        const targetStatus = (taskMatch[2] || 'Done').toLowerCase().includes('progress') ? 'In progress' : 'Done';

        if (client && guildConfig.actionItemsDbId && queryTerm) {
            const callerDisplay = (callerUser.displayName || '').toLowerCase().trim();
            const callerUsername = (callerUser.username || '').toLowerCase().trim();

            const items = await fetchActionItems(client, guildConfig.actionItemsDbId, { limit: 50 });

            // Strict IDOR Authorization Check:
            // Regular members can ONLY modify tasks assigned strictly to themselves (exact match).
            // They CANNOT modify unassigned tasks, and CANNOT modify other members' tasks.
            const isAssignedToCaller = (item) => {
                const a = (item.assignee || '').toLowerCase().trim();
                if (!a || a === 'unassigned') return false;
                return (callerDisplay && a === callerDisplay) || (callerUsername && a === callerUsername);
            };

            const matchingItems = items.filter((i) => i.task.toLowerCase().includes(queryTerm.toLowerCase()));

            if (matchingItems.length === 0) {
                return {
                    type: 'task_not_found',
                    message: `🔍 Couldn't find an action item matching "${queryTerm}" in the Action Items database.`,
                };
            }

            // If non-admin, verify assignee ownership on matching tasks
            if (!isAdmin) {
                const userMatching = matchingItems.filter(isAssignedToCaller);
                if (userMatching.length === 0) {
                    const otherAssignee = matchingItems[0].assignee;
                    return {
                        type: 'forbidden',
                        message: `⛔ **Permission Denied:** You cannot update this task because it is assigned to **@${otherAssignee}**. Regular members can only modify tasks assigned strictly to themselves.`,
                    };
                }

                if (userMatching.length > 1) {
                    // Check if there is an exact title match to disambiguate
                    const exact = userMatching.find((i) => i.task.toLowerCase() === queryTerm.toLowerCase());
                    if (!exact) {
                        return {
                            type: 'ambiguous',
                            message: `⚠️ Multiple action items assigned to you match "${queryTerm}". Please specify the exact task name.`,
                        };
                    }
                }
            }

            const matchedItem = (!isAdmin)
                ? (matchingItems.filter(isAssignedToCaller).find((i) => i.task.toLowerCase() === queryTerm.toLowerCase()) || matchingItems.filter(isAssignedToCaller)[0])
                : (matchingItems.find((i) => i.task.toLowerCase() === queryTerm.toLowerCase()) || matchingItems[0]);

            if (matchedItem) {
                const updated = await updateActionItemStatus(client, matchedItem.id, targetStatus);
                if (updated) {
                    logAudit({
                        guildId,
                        userId: callerUser.id,
                        userTag: callerUser.tag || callerUser.username,
                        action: 'task_updated',
                        targetMemberId: effectiveTargetUser.id,
                        details: { taskId: matchedItem.id, taskTitle: matchedItem.task, newStatus: targetStatus },
                    });
                    return {
                        type: 'task_updated',
                        message: `✅ **Task Updated in Notion Action Items:**\n` +
                            `- **Task:** "${matchedItem.task}"\n` +
                            `- **Status:** **${targetStatus}**\n` +
                            `🔗 [Open Task in Notion](${matchedItem.url})`,
                    };
                }
            }
        }
    }

    // 4. Default: Conversational follow-up question
    const qRes = await askGroundedAssistant({
        question: raw,
        callerUser,
        targetMember,
        guildConfig,
        recentMeetings,
        orgInfoText,
        provider,
        apiKey,
        model,
        guildId,
    });

    logAudit({
        guildId,
        userId: callerUser.id,
        userTag: callerUser.tag || callerUser.username,
        action: 'ask_followup',
        targetMemberId: effectiveTargetUser.id,
        details: raw,
    });

    return {
        type: 'answer',
        message: qRes.answer,
    };
}

module.exports = {
    queryDatabase,
    getOrCreateMemberPage,
    fetchMemberPersonalNotes,
    appendMemberPersonalNote,
    fetchActionItems,
    createActionItem,
    updateActionItemStatus,
    parseMeetingActionItemsAndWorkingDetails,
    syncMeetingTasksAndPersonalNotes,
    askGroundedAssistant,
    handleFollowUpInteraction,
};

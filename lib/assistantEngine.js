const { getNotionClient, withRetry, markdownToBlocks } = require('./notion');
const { fetchBlocksToMarkdown } = require('./notionScanner');
const {
    getGuildConfig,
    getGuildWiki,
    getNotionItem,
    upsertNotionItem,
    deleteNotionItem,
    searchNotionItems,
    getUserMappingByNotionName,
    getUserMapping,
    logApiRequest,
    logAudit,
} = require('./database');

/**
 * Generates the system prompt grounded in the server's Table of Contents (TOC).
 */
function getSystemPrompt(guildId) {
    const wiki = getGuildWiki(guildId);
    const toc = wiki?.wiki_toc_markdown || '_No Central Wiki mapped or scanned yet. Use /notion scan to build the index._';

    return `You are "Soren", a highly capable, stateful, Notion-grounded organizational assistant for this Discord server.
Your primary role is to act as the single source of truth and coordination hub for the company/team.

You have direct read/write access to the team's Central Wiki on Notion.
Here is the current Table of Contents / Map of the Workspace:
"""
${toc}
"""

STRICT GROUNDING & BEHAVIORAL RULES:
1. **Never Hallucinate Facts**: If asked a question about company policies, products, team members, or tasks, you MUST use the appropriate tools (\`search_workspace\`, \`read_page\`) to look up the actual content. Do not guess or assume.
2. **Always Reference Sources**: When answering based on workspace documents, always mention the document title and include its exact Notion URL so users can navigate to it.
3. **Write/Update with Care**: You can create/update pages and tasks when requested. Ensure the titles and body text are clean, well-formatted Markdown, and clearly structured.
4. **Task Assignment**: When creating tasks/action items, ask or look up the assignee's name to link them properly.
5. **Tone & Brevity**: Be extremely crisp, concise, and minimal. Avoid overwhelming the user with massive walls of text. State the direct answer or main takeaway immediately in 1-3 short sentences. Use bullet points for lists, and keep explanations highly focused. Do not use verbose preambles or post-summaries.

AVAILABLE TOOLS & HOW TO USE THEM:
- \`search_workspace(query)\`: Searches both local database index and Notion workspace for keywords.
- \`read_page(page_id)\`: Reads full Markdown body and properties of a specific page/item.
- \`create_page(parent_page_id, title, content_markdown)\`: Creates a new child page.
- \`update_page(page_id, title, content_markdown)\`: Updates/overwrites the title and content of an existing page.
- \`delete_page(page_id)\`: Archives/deletes a page.
- \`create_user_task(task_title, assignee_name, due_date, status)\`: Creates a task/action item in the team's database.`;
}

/**
 * Unified tool schemas in OpenAI / Groq tool format.
 */
const TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'search_workspace',
            description: 'Search the Notion wiki workspace for pages, documents, or tasks matching keywords.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The search query or keywords.' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_page',
            description: 'Read the full text content and metadata of a specific page, document, or task by its Notion ID.',
            parameters: {
                type: 'object',
                properties: {
                    page_id: { type: 'string', description: 'The 32-character Notion page or block UUID.' },
                },
                required: ['page_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'create_page',
            description: 'Create a new child document or page under a specified parent page.',
            parameters: {
                type: 'object',
                properties: {
                    parent_page_id: { type: 'string', description: 'The parent page UUID.' },
                    title: { type: 'string', description: 'The title of the new page.' },
                    content_markdown: { type: 'string', description: 'The initial content formatted in Markdown.' },
                },
                required: ['parent_page_id', 'title', 'content_markdown'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_page',
            description: 'Update or replace the title and markdown content of an existing page.',
            parameters: {
                type: 'object',
                properties: {
                    page_id: { type: 'string', description: 'The page UUID to update.' },
                    title: { type: 'string', description: 'The new title (optional).' },
                    content_markdown: { type: 'string', description: 'The new markdown body content (optional).' },
                },
                required: ['page_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'delete_page',
            description: 'Archive or delete a page/document in Notion.',
            parameters: {
                type: 'object',
                properties: {
                    page_id: { type: 'string', description: 'The page UUID to archive.' },
                },
                required: ['page_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'create_user_task',
            description: 'Create a task or action item in the team Action Items database.',
            parameters: {
                type: 'object',
                properties: {
                    task_title: { type: 'string', description: 'The title of the task.' },
                    assignee_name: { type: 'string', description: 'The name of the assignee (e.g., Discord or Notion name).' },
                    due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format (optional).' },
                    status: { type: 'string', description: 'Task status like "Not started", "In progress", "Completed" (optional).' },
                },
                required: ['task_title'],
            },
        },
    },
];

/**
 * Executes a tool called by the LLM.
 */
async function executeTool(guildId, name, args) {
    const config = getGuildConfig(guildId);
    if (!config.notionToken) {
        return 'Error: Notion token is not configured for this server. Ask an admin to set it up.';
    }

    const client = getNotionClient(config.notionToken);

    try {
        switch (name) {
            case 'search_workspace': {
                const query = args.query;
                // 1. Local Cache search (FTS5)
                const localResults = searchNotionItems(guildId, query);

                // 2. Live Notion search
                let liveResults = [];
                try {
                    const res = await withRetry(() => client.search({
                        query,
                        page_size: 10,
                    }));
                    liveResults = res.results || [];
                } catch {
                    // Fail gracefully
                }

                // Merge results
                const mergedMap = new Map();
                for (const item of localResults) {
                    mergedMap.set(item.id, {
                        id: item.id,
                        title: item.title,
                        type: item.type,
                        url: item.url,
                        source: 'Local Cache',
                    });
                }

                for (const item of liveResults) {
                    const id = item.id.replace(/-/g, '');
                    let title = 'Untitled';
                    if (item.properties?.title?.title) {
                        title = item.properties.title.title.map((t) => t.plain_text).join('');
                    } else if (item.properties?.Name?.title) {
                        title = item.properties.Name.title.map((t) => t.plain_text).join('');
                    } else if (item.title) {
                        title = item.title.map((t) => t.plain_text).join('');
                    }

                    mergedMap.set(id, {
                        id,
                        title,
                        type: item.object || 'page',
                        url: item.url,
                        source: 'Live Notion',
                    });
                }

                const merged = Array.from(mergedMap.values()).slice(0, 10);
                if (merged.length === 0) return 'No matching items found in the workspace.';

                return JSON.stringify(merged, null, 2);
            }

            case 'read_page': {
                const pageId = args.page_id.replace(/-/g, '');
                // Try cache first
                const cached = getNotionItem(pageId);
                let contentMarkdown = '';
                let title = cached?.title || '';
                let url = cached?.url || `https://notion.so/${pageId}`;

                try {
                    // Fetch live for fresh content
                    contentMarkdown = await fetchBlocksToMarkdown(client, pageId, 3, 0);

                    // Fetch page details for properties
                    const page = await withRetry(() => client.pages.retrieve({ page_id: pageId }));
                    url = page.url || url;
                    if (page.properties?.title?.title) {
                        title = page.properties.title.title.map((t) => t.plain_text).join('');
                    } else if (page.properties?.Name?.title) {
                        title = page.properties.Name.title.map((t) => t.plain_text).join('');
                    }

                    // Update cache
                    upsertNotionItem({
                        id: pageId,
                        guildId,
                        parentId: page.parent?.page_id || page.parent?.database_id || null,
                        databaseId: page.parent?.database_id || null,
                        type: page.object || 'page',
                        title,
                        url,
                        contentMarkdown,
                        updatedAt: Date.now(),
                    });
                } catch (err) {
                    if (cached) {
                        return JSON.stringify({
                            id: cached.id,
                            title: cached.title,
                            type: cached.type,
                            url: cached.url,
                            contentMarkdown: cached.content_markdown,
                            source: 'Cached (Offline/Error reading live)',
                        }, null, 2);
                    }
                    throw err;
                }

                return JSON.stringify({ id: pageId, title, url, contentMarkdown }, null, 2);
            }

            case 'create_page': {
                const { parent_page_id, title, content_markdown } = args;
                const parentIdClean = parent_page_id.replace(/-/g, '');

                const newPage = await withRetry(() => client.pages.create({
                    parent: { page_id: parentIdClean },
                    properties: {
                        title: [{ text: { content: title } }],
                    },
                }));

                const newPageId = newPage.id.replace(/-/g, '');

                // Append content blocks
                const blocks = markdownToBlocks(content_markdown);
                if (blocks && blocks.length > 0) {
                    // Notion blocks list append has a limit of 100 blocks per request
                    const chunkSize = 100;
                    for (let i = 0; i < blocks.length; i += chunkSize) {
                        const chunk = blocks.slice(i, i + chunkSize);
                        await withRetry(() => client.blocks.children.append({
                            block_id: newPageId,
                            children: chunk,
                        }));
                    }
                }

                // Cache it
                upsertNotionItem({
                    id: newPageId,
                    guildId,
                    parentId: parentIdClean,
                    type: 'page',
                    title,
                    url: newPage.url,
                    contentMarkdown: content_markdown,
                    updatedAt: Date.now(),
                });

                return JSON.stringify({
                    success: true,
                    message: `Page "${title}" successfully created under parent ${parent_page_id}.`,
                    url: newPage.url,
                    id: newPageId,
                });
            }

            case 'update_page': {
                const { page_id, title, content_markdown } = args;
                const pageIdClean = page_id.replace(/-/g, '');

                // Retrieve page object to get details
                const page = await withRetry(() => client.pages.retrieve({ page_id: pageIdClean }));

                if (title) {
                    const titleProp = page.object === 'page' ? 'title' : 'Name';
                    await withRetry(() => client.pages.update({
                        page_id: pageIdClean,
                        properties: {
                            [titleProp]: [{ text: { content: title } }],
                        },
                    }));
                }

                if (content_markdown !== undefined) {
                    // Replace block children: first archive old blocks, then add new
                    const existingChildren = await withRetry(() => client.blocks.children.list({ block_id: pageIdClean }));
                    for (const child of (existingChildren.results || [])) {
                        await withRetry(() => client.blocks.delete({ block_id: child.id }));
                    }

                    const blocks = markdownToBlocks(content_markdown);
                    if (blocks && blocks.length > 0) {
                        const chunkSize = 100;
                        for (let i = 0; i < blocks.length; i += chunkSize) {
                            const chunk = blocks.slice(i, i + chunkSize);
                            await withRetry(() => client.blocks.children.append({
                                block_id: pageIdClean,
                                children: chunk,
                            }));
                        }
                    }
                }

                // Update cache
                const freshContent = content_markdown !== undefined ? content_markdown : (getNotionItem(pageIdClean)?.content_markdown || '');
                const freshTitle = title || getNotionItem(pageIdClean)?.title || 'Untitled';

                upsertNotionItem({
                    id: pageIdClean,
                    guildId,
                    parentId: page.parent?.page_id || page.parent?.database_id || null,
                    databaseId: page.parent?.database_id || null,
                    type: page.object || 'page',
                    title: freshTitle,
                    url: page.url,
                    contentMarkdown: freshContent,
                    updatedAt: Date.now(),
                });

                return JSON.stringify({
                    success: true,
                    message: `Page ${page_id} updated successfully.`,
                    url: page.url,
                });
            }

            case 'delete_page': {
                const pageIdClean = args.page_id.replace(/-/g, '');
                await withRetry(() => client.pages.update({
                    page_id: pageIdClean,
                    archived: true,
                }));

                deleteNotionItem(pageIdClean);

                return JSON.stringify({
                    success: true,
                    message: `Page ${args.page_id} successfully archived/deleted in Notion and local cache.`,
                });
            }

            case 'create_user_task': {
                const { task_title, assignee_name, due_date, status } = args;

                if (!config.actionItemsDbId) {
                    return 'Error: Action Items database is not configured. Run /notion status or /notes notionprovision to set up structural databases.';
                }

                // Find assignee Notion user ID
                let notionUserId = null;
                if (assignee_name) {
                    const mapping = getUserMappingByNotionName(guildId, assignee_name);
                    if (mapping) {
                        notionUserId = mapping.notion_user_id;
                    }
                }

                // Build properties based on Action Items DB structure
                const properties = {
                    Name: { title: [{ text: { content: task_title } }] },
                };

                if (status) {
                    properties.Status = { status: { name: status } };
                }
                if (due_date) {
                    properties['Due Date'] = { date: { start: due_date } };
                }
                if (notionUserId) {
                    properties.Assignee = { people: [{ id: notionUserId }] };
                }

                const newTask = await withRetry(() => client.pages.create({
                    parent: { database_id: config.actionItemsDbId },
                    properties,
                }));

                const taskIdClean = newTask.id.replace(/-/g, '');

                // Cache task
                upsertNotionItem({
                    id: taskIdClean,
                    guildId,
                    parentId: config.actionItemsDbId,
                    databaseId: config.actionItemsDbId,
                    type: 'task',
                    title: task_title,
                    status: status || 'Not started',
                    assignee: assignee_name || null,
                    dueDate: due_date || null,
                    propertiesJson: JSON.stringify(parsePropertiesForCache(properties)),
                    contentMarkdown: '',
                    url: newTask.url,
                    updatedAt: Date.now(),
                });

                return JSON.stringify({
                    success: true,
                    message: `Task "${task_title}" created in Action Items database.`,
                    url: newTask.url,
                    id: taskIdClean,
                });
            }

            default:
                return `Error: Unknown tool "${name}"`;
        }
    } catch (err) {
        console.error(`[assistantEngine] Tool ${name} execution error:`, err);
        return `Error executing tool ${name}: ${err.message}`;
    }
}

function parsePropertiesForCache(properties) {
    const cacheProps = {};
    for (const [k, v] of Object.entries(properties)) {
        if (v.title) cacheProps[k] = v.title[0]?.text?.content;
        else if (v.status) cacheProps[k] = v.status.name;
        else if (v.date) cacheProps[k] = v.date.start;
        else if (v.people) cacheProps[k] = v.people.map((p) => p.id);
    }
    return cacheProps;
}

/**
 * Handles multi-turn tool loops with Gemini / Groq to answer grounded questions.
 */
async function runGroundedAssistant(guildId, userId, messageHistory) {
    const config = getGuildConfig(guildId);
    const provider = config.summaryProvider || 'groq';

    const systemPrompt = getSystemPrompt(guildId);

    // Build standard messages array
    const messages = [
        { role: 'system', content: systemPrompt },
        ...messageHistory,
    ];

    let loopCount = 0;
    const maxLoops = 8;

    while (loopCount < maxLoops) {
        loopCount++;
        let responseData;

        if (provider === 'gemini' && config.geminiApiKey) {
            // Call Gemini via REST
            const model = config.geminiModel || 'gemini-2.5-flash';
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`;

            // Map messages to Gemini API format
            const contents = messages.map((m) => {
                const role = m.role === 'assistant' ? 'model' : 'user';
                // If it is system, standard gemini API has systemInstruction block, we handle system outside in config
                if (m.role === 'system') return null;

                const parts = [];
                if (m.content) parts.push({ text: m.content });

                if (m.tool_calls) {
                    for (const tc of m.tool_calls) {
                        parts.push({
                            functionCall: {
                                name: tc.function.name,
                                args: JSON.parse(tc.function.arguments),
                            },
                        });
                    }
                }

                if (m.role === 'tool') {
                    parts.push({
                        functionResponse: {
                            name: m.name,
                            response: { result: m.content },
                        },
                    });
                }

                return { role, parts };
            }).filter(Boolean);

            const geminiTools = TOOL_DEFINITIONS.map((td) => ({
                name: td.function.name,
                description: td.function.description,
                parameters: td.function.parameters,
            }));

            const payload = {
                contents,
                systemInstruction: { parts: [{ text: systemPrompt }] },
                tools: [{ functionDeclarations: geminiTools }],
            };

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Gemini API Tool-Loop Error (${response.status}): ${errorText}`);
            }

            const data = await response.json();
            logApiRequest({
                guildId,
                service: 'gemini_assistant',
                model,
                status: 'success',
                tokensUsed: data.usageMetadata?.totalTokenCount || 0,
            });

            const candidate = data.candidates?.[0];
            const modelParts = candidate?.content?.parts || [];
            const textPart = modelParts.find((p) => p.text);
            const text = textPart?.text || '';

            const functionCalls = modelParts.filter((p) => p.functionCall).map((p) => ({
                id: `call_${Math.random().toString(36).substring(2, 9)}`,
                type: 'function',
                function: {
                    name: p.functionCall.name,
                    arguments: JSON.stringify(p.functionCall.args),
                },
            }));

            if (functionCalls.length > 0) {
                // Save assistant message to messages
                messages.push({
                    role: 'assistant',
                    content: text || null,
                    tool_calls: functionCalls,
                });

                // Execute tool calls and push tool responses
                for (const tc of functionCalls) {
                    const result = await executeTool(guildId, tc.function.name, JSON.parse(tc.function.arguments));
                    messages.push({
                        role: 'tool',
                        name: tc.function.name,
                        tool_call_id: tc.id,
                        content: result,
                    });
                }
            } else {
                return text;
            }
        } else {
            // Groq
            const apiKey = config.groqApiKey || process.env.GROQ_API_KEY;
            if (!apiKey) {
                throw new Error('Groq API Key is not configured for this server.');
            }

            const model = config.groqModel || 'llama-3.3-70b-versatile';

            // Filter out system from message body since we put it explicitly
            const bodyMessages = messages.map((m) => {
                if (m.role === 'system') return null;
                const formatted = { role: m.role, content: m.content };
                if (m.tool_calls) formatted.tool_calls = m.tool_calls;
                if (m.tool_call_id) formatted.tool_call_id = m.tool_call_id;
                if (m.name) formatted.name = m.name;
                return formatted;
            }).filter(Boolean);

            const payload = {
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...bodyMessages,
                ],
                tools: TOOL_DEFINITIONS,
                tool_choice: 'auto',
                temperature: 0.2,
            };

            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Groq API Tool-Loop Error (${response.status}): ${errorText}`);
            }

            const data = await response.json();
            logApiRequest({
                guildId,
                service: 'groq_assistant',
                model,
                status: 'success',
                tokensUsed: data.usage?.total_tokens || 0,
            });

            const choice = data.choices?.[0];
            const message = choice?.message;
            const text = message?.content || '';

            if (message?.tool_calls && message.tool_calls.length > 0) {
                messages.push({
                    role: 'assistant',
                    content: text || null,
                    tool_calls: message.tool_calls,
                });

                for (const tc of message.tool_calls) {
                    const result = await executeTool(guildId, tc.function.name, JSON.parse(tc.function.arguments));
                    messages.push({
                        role: 'tool',
                        name: tc.function.name,
                        tool_call_id: tc.id,
                        content: result,
                    });
                }
            } else {
                return text;
            }
        }
    }

    throw new Error('Tool calling loop exceeded maximum iterations (loop protection triggered).');
}

module.exports = {
    runGroundedAssistant,
    executeTool,
    getSystemPrompt,
};

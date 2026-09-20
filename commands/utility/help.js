const { SlashCommandBuilder } = require('discord.js');
const { sendSafeChunkedReply } = require('../../lib/discordUtils');

/**
 * Registry of manual pages (man pages) for all Soren commands.
 * Formatted according to UNIX man-page conventions (NAME, SYNOPSIS,
 * DESCRIPTION, OPTIONS / SUBCOMMANDS, PERMISSIONS, EXAMPLES, SEE ALSO).
 */
const MAN_PAGES = {
	ping: {
		name: 'ping',
		section: 1,
		title: 'PING',
		summary: 'Connection latency test and user profile identification',
		synopsis: '/ping',
		description:
			'Pings the Soren bot service to verify gateway connectivity and responsiveness.\n' +
			'Returns a confirmation message with the user\'s display name, global name,\n' +
			'username, and an attached avatar image.',
		options: [],
		permissions: 'Everyone (@everyone)',
		prerequisites: 'None',
		examples: [
			{ command: '/ping', comment: 'Check bot connection and view your profile information' },
		],
		seeAlso: ['restart(8)', 'help(1)'],
	},

	ask: {
		name: 'ask',
		section: 1,
		title: 'ASK',
		summary: 'Query grounded company assistant across Notion wiki docs, tasks, and policies',
		synopsis: '/ask question:<string>',
		description:
			'Queries Soren\'s grounded organizational AI assistant (powered by Gemini).\n' +
			'The assistant dynamically retrieves context from the server\'s Notion Central\n' +
			'Wiki, cached databases, meeting transcripts, and action items to provide a\n' +
			'factual, cited, and strictly grounded response.',
		options: [
			{
				name: 'question',
				type: 'String',
				required: true,
				description: 'The natural language question you want to ask about docs, policies, or tasks.',
			},
		],
		permissions: 'Everyone (@everyone)',
		prerequisites: 'Notion integration must be configured on the server via `/notion setup`.',
		notes: [
			'Can only be run inside a Discord server (not in DMs).',
			'You can also invoke the assistant by mentioning @Soren in any text channel.',
		],
		examples: [
			{ command: '/ask question:What were the key decisions made in yesterday\'s product sync?', comment: 'Query meeting decisions' },
			{ command: '/ask question:What is our current PTO and sick leave policy?', comment: 'Lookup company policy' },
			{ command: '/ask question:What action items are assigned to me for this sprint?', comment: 'Check assigned tasks' },
		],
		seeAlso: ['notes-ask(1)', 'notion(8)', 'notion-status(8)'],
	},

	join: {
		name: 'join',
		section: 1,
		title: 'JOIN',
		summary: 'Connect bot to caller\'s current voice channel',
		synopsis: '/join',
		description:
			'Instructs Soren to join the Discord voice channel that the invoking member\n' +
			'is currently connected to. Establishes a voice connection and waits up to 15\n' +
			'seconds for the connection to reach the Ready state.',
		options: [],
		permissions: 'Voice channel participants',
		prerequisites: 'The invoking member must currently be in an active voice channel.',
		notes: [
			'If you intend to take meeting notes, you can use `/notes start` directly, which joins automatically.',
		],
		examples: [
			{ command: '/join', comment: 'Summon bot to your active voice channel' },
		],
		seeAlso: ['leave(1)', 'notes-start(1)'],
	},

	leave: {
		name: 'leave',
		section: 1,
		title: 'LEAVE',
		summary: 'Disconnect bot from the current voice channel',
		synopsis: '/leave',
		description:
			'Instructs Soren to gracefully disconnect from the active voice channel.\n' +
			'To protect against unintended data loss, if an active voice note-taking session\n' +
			'is currently running, this command is blocked and prompts the user to use\n' +
			'`/notes stop` instead.',
		options: [],
		permissions: 'Voice channel participants',
		prerequisites: 'Bot must be connected to a voice channel in this server.',
		notes: [
			'Blocked while a `/notes` session is running. Use `/notes stop` to end the session and leave.',
		],
		examples: [
			{ command: '/leave', comment: 'Disconnect bot from voice' },
		],
		seeAlso: ['join(1)', 'notes-stop(1)'],
	},

	restart: {
		name: 'restart',
		section: 8,
		title: 'RESTART',
		summary: 'Gracefully terminate the bot process for supervisor reboot (Admin only)',
		synopsis: '/restart',
		description:
			'Initiates a clean exit of the Soren Node.js process (`process.exit(0)`).\n' +
			'When Soren is managed under an automatic process supervisor (such as systemd,\n' +
			'PM2, or Docker with a restart policy), the process supervisor immediately\n' +
			're-spawns the bot, reloading codebase changes and clearing runtime state.',
		options: [],
		permissions: 'Administrator only (Server Administrator permissions required)',
		prerequisites: 'Caller must possess Discord Administrator permission.',
		notes: [
			'If the bot is not run under a process supervisor, manual intervention is required to bring it back online.',
		],
		examples: [
			{ command: '/restart', comment: 'Reboot bot process to apply updates' },
		],
		seeAlso: ['ping(1)', 'help(1)'],
	},

	notion: {
		name: 'notion',
		section: 8,
		title: 'NOTION',
		summary: 'Configure and manage Notion Central Wiki workspace integration',
		synopsis:
			'/notion setup token:<token> wiki_page_id:<id>\n' +
			'       /notion scan [depth:<int>] [limit:<int>]\n' +
			'       /notion status\n' +
			'       /notion link-member discord_user:<user> notion_name_or_email:<string>',
		description:
			'Administrative suite to manage the integration between this Discord server and\n' +
			'a Notion workspace. Manages internal integration secrets, validates Central\n' +
			'Wiki page hierarchy, executes recursive discovery scans, and maintains mappings\n' +
			'between Discord user accounts and Notion member profiles.',
		permissions: 'Administrator only (Server Administrator permissions required)',
		prerequisites: 'Notion Internal Integration Token with Read/Write access to the target Central Wiki page.',
		subcommands: [
			{
				name: 'setup',
				synopsis: '/notion setup token:<token> wiki_page_id:<id>',
				description: 'Configure Notion API secret token and Central Wiki Page ID. Validates access before saving.',
				options: [
					{ name: 'token', type: 'String', required: true, description: 'Notion Integration Secret Token (starts with ntn_ or secret_)' },
					{ name: 'wiki_page_id', type: 'String', required: true, description: 'UUID or full URL of your Central Wiki Root Page' },
				],
			},
			{
				name: 'scan',
				synopsis: '/notion scan [depth:<int>] [limit:<int>]',
				description: 'Recursively scan the Central Wiki hierarchy to discover and cache sub-pages and databases.',
				options: [
					{ name: 'depth', type: 'Integer', required: false, description: 'Scan recursion depth limit (default: 3)' },
					{ name: 'limit', type: 'Integer', required: false, description: 'Maximum page/database items to scan (default: 100)' },
				],
			},
			{
				name: 'status',
				synopsis: '/notion status',
				description: 'Inspect Notion integration settings, token status, cached wiki items, and member mappings.',
				options: [],
			},
			{
				name: 'link-member',
				synopsis: '/notion link-member discord_user:<user> notion_name_or_email:<string>',
				description: 'Link a Discord user to their Notion profile for task assignment and personal notes.',
				options: [
					{ name: 'discord_user', type: 'User', required: true, description: 'The Discord member to link' },
					{ name: 'notion_name_or_email', type: 'String', required: true, description: 'Their exact Notion Name or email address' },
				],
			},
		],
		examples: [
			{ command: '/notion setup token:ntn_123... wiki_page_id:https://notion.so/Central-Wiki-abc', comment: 'Connect Notion workspace' },
			{ command: '/notion scan depth:3 limit:150', comment: 'Re-index Central Wiki pages & databases' },
			{ command: '/notion status', comment: 'Review connection and cached statistics' },
			{ command: '/notion link-member discord_user:@Alice notion_name_or_email:alice@company.com', comment: 'Map Discord user to Notion' },
		],
		seeAlso: ['notes-setnotion(8)', 'notes-createhub(8)', 'ask(1)'],
	},

	notes: {
		name: 'notes',
		section: 1,
		title: 'NOTES',
		summary: 'Voice notes recording, STT transcription, AI summaries, and Notion sync',
		synopsis:
			'/notes start [provider:<groq|gemini>] [model:<string>]\n' +
			'       /notes stop\n' +
			'       /notes channel [channel:<channel>]\n' +
			'       /notes stats\n' +
			'       /notes keyinfo\n' +
			'       /notes setkey [groq_key] [gemini_key] [provider] [groq_model] [gemini_model]\n' +
			'       /notes setmodel [groq_model] [gemini_model]\n' +
			'       /notes clearkey\n' +
			'       /notes setnotion token:<token> wiki:<wiki>\n' +
			'       /notes notioninfo\n' +
			'       /notes clearnotion\n' +
			'       /notes notionprovision\n' +
			'       /notes createhub [name:<string>]\n' +
			'       /notes syncmode mode:<automatic|manual>\n' +
			'       /notes sync [notes:<string>]\n' +
			'       /notes ask question:<string> [member:<user>]\n' +
			'       /notes audit [limit:<int>]',
		description:
			'Complete voice meeting intelligence suite. Connects to voice channels, captures\n' +
			'multi-user audio streams with Opus decoding and 16kHz mono resampling, transcribes\n' +
			'speech via Groq Whisper STT with speaker attribution, generates executive\n' +
			'summaries using Groq or Gemini LLMs, delivers summaries to Discord, and automatically\n' +
			'publishes meeting notes, tasks, and org knowledge into Notion.',
		permissions:
			'User commands (start, stop, channel view, stats, keyinfo, notioninfo, ask):\n' +
			'    Available to all server members.\n' +
			'Admin commands (setkey, setmodel, clearkey, setnotion, clearnotion, notionprovision,\n' +
			'createhub, syncmode, sync, audit, channel set):\n' +
			'    Administrator only.',
		prerequisites:
			'• Groq API Key must be configured (via `/notes setkey` or env).\n' +
			'• For Notion publishing: Notion integration configured via `/notes setnotion` or `/notion setup`.',
		subcommands: [
			{
				name: 'start',
				synopsis: '/notes start [provider:<groq|gemini>] [model:<string>]',
				description: 'Join caller\'s voice channel and begin live audio capture and transcription.',
				options: [
					{ name: 'provider', type: 'String', required: false, description: 'Override summary AI provider (\'groq\' or \'gemini\')' },
					{ name: 'model', type: 'String', required: false, description: 'Override summary model code name (e.g. gemini-2.5-flash)' },
				],
			},
			{
				name: 'stop',
				synopsis: '/notes stop',
				description: 'Stop meeting recording, finish transcription, generate AI summary, post to Discord & sync to Notion.',
				options: [],
			},
			{
				name: 'channel',
				synopsis: '/notes channel [channel:<channel>]',
				description: 'View current target notes channel or set a new text channel for meeting summaries.',
				options: [
					{ name: 'channel', type: 'Channel', required: false, description: 'Target text channel (omit to view current setting)' },
				],
			},
			{
				name: 'setkey',
				synopsis: '/notes setkey [groq_key] [gemini_key] [provider] [groq_model] [gemini_model]',
				description: '[Admin] Configure Groq and Gemini API keys and default summary models for this server.',
				options: [
					{ name: 'groq_key', type: 'String', required: false, description: 'Groq API Key (used for voice STT and Groq summaries)' },
					{ name: 'gemini_key', type: 'String', required: false, description: 'Gemini API Key (optional for Gemini summaries)' },
					{ name: 'provider', type: 'String', required: false, description: 'Preferred summary AI provider (\'groq\' or \'gemini\')' },
					{ name: 'groq_model', type: 'String', required: false, description: 'Groq model code name (e.g. openai/gpt-oss-120b)' },
					{ name: 'gemini_model', type: 'String', required: false, description: 'Gemini model code name (e.g. gemini-2.5-flash)' },
				],
			},
			{
				name: 'setmodel',
				synopsis: '/notes setmodel [groq_model] [gemini_model]',
				description: '[Admin] Set summary AI model code names without re-entering API keys.',
				options: [
					{ name: 'groq_model', type: 'String', required: false, description: 'Groq model code name' },
					{ name: 'gemini_model', type: 'String', required: false, description: 'Gemini model code name' },
				],
			},
			{
				name: 'clearkey',
				synopsis: '/notes clearkey',
				description: '[Admin] Clear all stored API keys and custom model configurations for this server.',
				options: [],
			},
			{
				name: 'keyinfo',
				synopsis: '/notes keyinfo',
				description: 'View masked API key status and configured model names for this server.',
				options: [],
			},
			{
				name: 'stats',
				synopsis: '/notes stats',
				description: 'View voice notes statistics, total recorded meetings, and recent session history.',
				options: [],
			},
			{
				name: 'setnotion',
				synopsis: '/notes setnotion token:<token> wiki:<wiki>',
				description: '[Admin] Connect this server to a Notion Central Wiki root page and store credentials.',
				options: [
					{ name: 'token', type: 'String', required: true, description: 'Notion internal integration secret token' },
					{ name: 'wiki', type: 'String', required: true, description: 'Notion Wiki root page URL or UUID' },
				],
			},
			{
				name: 'notioninfo',
				synopsis: '/notes notioninfo',
				description: 'View Notion wiki connection details, page title, and database IDs.',
				options: [],
			},
			{
				name: 'clearnotion',
				synopsis: '/notes clearnotion',
				description: '[Admin] Disconnect and clear Notion wiki configuration for this server.',
				options: [],
			},
			{
				name: 'notionprovision',
				synopsis: '/notes notionprovision',
				description: '[Admin] Verify or create essential wiki databases (Meetings, Org Info, Action Items).',
				options: [],
			},
			{
				name: 'createhub',
				synopsis: '/notes createhub [name:<string>]',
				description: '[Admin] Generate a full executive Soren-style Central Wiki Dashboard layout in Notion.',
				options: [
					{ name: 'name', type: 'String', required: false, description: 'Organization name (default: server name)' },
				],
			},
			{
				name: 'syncmode',
				synopsis: '/notes syncmode mode:<automatic|manual>',
				description: '[Admin] Toggle Org Info sync between automatic (after every meeting) and manual.',
				options: [
					{ name: 'mode', type: 'String', required: true, description: 'Sync mode: \'automatic\' or \'manual\'' },
				],
			},
			{
				name: 'sync',
				synopsis: '/notes sync [notes:<string>]',
				description: '[Admin] Extract and sync facts and decisions from the latest meeting into Org Info.',
				options: [
					{ name: 'notes', type: 'String', required: false, description: 'Optional specific notes text to sync (omit for latest meeting)' },
				],
			},
			{
				name: 'ask',
				synopsis: '/notes ask question:<string> [member:<user>]',
				description: 'Ask questions grounded in the server wiki, meeting notes, and personal tasks.',
				options: [
					{ name: 'question', type: 'String', required: true, description: 'Your question about projects, decisions, meetings, or tasks' },
					{ name: 'member', type: 'User', required: false, description: '[Admin only] Query another member\'s personal notes & tasks' },
				],
			},
			{
				name: 'audit',
				synopsis: '/notes audit [limit:<int>]',
				description: '[Admin] View recent assistant Q&A and Notion update audit logs.',
				options: [
					{ name: 'limit', type: 'Integer', required: false, description: 'Number of logs to view (default: 10, max: 25)' },
				],
			},
		],
		examples: [
			{ command: '/notes start', comment: 'Start recording current voice meeting' },
			{ command: '/notes start provider:gemini model:gemini-2.5-flash', comment: 'Record with Gemini summary' },
			{ command: '/notes stop', comment: 'End meeting and publish notes & Notion sync' },
			{ command: '/notes channel channel:#meeting-notes', comment: 'Designate notes channel' },
			{ command: '/notes createhub name:Acme Corp', comment: 'Build executive Notion Central Wiki' },
			{ command: '/notes ask question:What tasks were assigned to me?', comment: 'Check your action items' },
			{ command: '/notes audit limit:5', comment: 'Inspect security audit log' },
		],
		seeAlso: ['ask(1)', 'join(1)', 'leave(1)', 'notion(8)', 'help(1)'],
	},

	help: {
		name: 'help',
		section: 1,
		title: 'HELP',
		summary: 'Display manual pages and reference documentation for Soren commands',
		synopsis:
			'/help\n' +
			'       /help command:<command>\n' +
			'       /help command:<command> subcommand:<subcommand>',
		description:
			'Provides comprehensive, man-page style reference documentation for all Soren\n' +
			'bot commands. When invoked with no parameters, it outputs the Manual Overview\n' +
			'and command index. When given a command name, it displays the complete UNIX man\n' +
			'page with synopsis, detailed options, permission requirements, and examples.\n' +
			'Subcommands can also be individually inspected.',
		options: [
			{
				name: 'command',
				type: 'String',
				required: false,
				description: 'The command name to inspect (e.g. notes, notion, ask, join, leave, ping, restart).',
			},
			{
				name: 'subcommand',
				type: 'String',
				required: false,
				description: 'Specific subcommand to inspect (e.g. start, stop, setup, scan).',
			},
		],
		permissions: 'Everyone (@everyone)',
		prerequisites: 'None',
		examples: [
			{ command: '/help', comment: 'View manual table of contents and command index' },
			{ command: '/help command:notes', comment: 'View complete man page for /notes' },
			{ command: '/help command:notes subcommand:start', comment: 'Deep dive into /notes start subcommand' },
			{ command: '/help command:notion subcommand:setup', comment: 'Inspect /notion setup subcommand' },
			{ command: '/help command:ask', comment: 'View man page for /ask' },
		],
		seeAlso: ['notes(1)', 'notion(8)', 'ask(1)', 'ping(1)'],
	},
};

/**
 * Formats the general manual overview (MANUAL(1) Table of Contents).
 */
function formatOverview() {
	return [
		'```text',
		'SOREN(1)                      Manual Pages                      SOREN(1)',
		'',
		'NAME',
		'    soren - Enterprise AI voice meeting recorder, grounded assistant & Notion wiki bot',
		'',
		'SYNOPSIS',
		'    /<command> [subcommand] [arguments...]',
		'    @Soren <question>',
		'',
		'DESCRIPTION',
		'    Soren is an enterprise AI assistant for Discord teams. It provides voice',
		'    channel meeting recording, multi-speaker STT transcription via Groq Whisper,',
		'    automated executive summaries via Groq and Gemini LLMs, Notion Central Wiki',
		'    synchronization, and grounded Q&A over company docs, policies, and tasks.',
		'',
		'MANUAL SECTIONS & COMMAND INDEX',
		'',
		'    SECTION 1: VOICE & MEETING INTELLIGENCE',
		'        notes(1)     Voice notes recording, STT, AI summaries & Notion sync',
		'        join(1)      Connect bot to caller\'s current voice channel',
		'        leave(1)     Disconnect bot from the current voice channel',
		'',
		'    SECTION 2: KNOWLEDGE BASE & GROUNDED ASSISTANT',
		'        ask(1)       Query grounded assistant on wiki, docs, tasks & policies',
		'        notion(8)    Configure and manage Notion workspace integration',
		'',
		'    SECTION 3: SYSTEM & ADMINISTRATION',
		'        ping(1)      Connection latency test and user identification',
		'        restart(8)   Gracefully restart the bot process (Admin only)',
		'        help(1)      Display manual pages and documentation for commands',
		'',
		'USAGE INSTRUCTIONS',
		'    • Run `/help command:<name>` to display the detailed man page for any command.',
		'      Example: `/help command:notes` or `/help command:notion`',
		'    • Run `/help command:<name> subcommand:<subcommand>` for subcommand details.',
		'      Example: `/help command:notes subcommand:start`',
		'    • In any text channel, mention `@Soren <question>` to ask anything directly.',
		'',
		'Soren 1.0.0                  Manual Pages                       SOREN(1)',
		'```',
	].join('\n');
}

/**
 * Formats a comprehensive man page for a top-level command.
 */
function formatCommandManPage(man) {
	const headerTag = `${man.title}(${man.section})`;
	const padLen = Math.max(0, 72 - (headerTag.length * 2) - 16);
	const spaces = ' '.repeat(padLen);
	const header = `${headerTag}${spaces}Soren Manual${spaces}${headerTag}`;

	const lines = [
		'```text',
		header,
		'',
		'NAME',
		`    ${man.name} - ${man.summary}`,
		'',
		'SYNOPSIS',
	];

	for (const synLine of man.synopsis.split('\n')) {
		lines.push(`    ${synLine}`);
	}

	lines.push('', 'DESCRIPTION');
	for (const descLine of man.description.split('\n')) {
		lines.push(`    ${descLine}`);
	}

	if (man.subcommands && man.subcommands.length > 0) {
		lines.push('', 'SUBCOMMANDS');
		for (const sub of man.subcommands) {
			lines.push(`    ${sub.synopsis}`);
			lines.push(`        ${sub.description}`);
			if (sub.options && sub.options.length > 0) {
				for (const opt of sub.options) {
					const reqText = opt.required ? 'Required' : 'Optional';
					lines.push(`        • ${opt.name} (${reqText}, ${opt.type}): ${opt.description}`);
				}
			}
			lines.push('');
		}
		// Remove extra blank line if present
		if (lines[lines.length - 1] === '') lines.pop();
	} else if (man.options && man.options.length > 0) {
		lines.push('', 'OPTIONS & ARGUMENTS');
		for (const opt of man.options) {
			const reqText = opt.required ? 'Required' : 'Optional';
			lines.push(`    ${opt.name} (${reqText}, ${opt.type})`);
			lines.push(`        ${opt.description}`);
		}
	}

	if (man.permissions) {
		lines.push('', 'PERMISSIONS & ACCESS');
		for (const permLine of man.permissions.split('\n')) {
			lines.push(`    ${permLine}`);
		}
	}

	if (man.prerequisites) {
		lines.push('', 'PREREQUISITES');
		for (const prereqLine of man.prerequisites.split('\n')) {
			lines.push(`    ${prereqLine}`);
		}
	}

	if (man.notes && man.notes.length > 0) {
		lines.push('', 'NOTES');
		for (const note of man.notes) {
			lines.push(`    • ${note}`);
		}
	}

	if (man.examples && man.examples.length > 0) {
		lines.push('', 'EXAMPLES');
		for (const ex of man.examples) {
			lines.push(`    ${ex.command}`);
			lines.push(`        # ${ex.comment}`);
		}
	}

	if (man.seeAlso && man.seeAlso.length > 0) {
		lines.push('', 'SEE ALSO');
		lines.push(`    ${man.seeAlso.join(', ')}`);
	}

	const footerSpaces = ' '.repeat(Math.max(0, 72 - 24 - headerTag.length));
	lines.push(
		'',
		`Soren 1.0.0${footerSpaces}${headerTag}`,
		'```'
	);

	return lines.join('\n');
}

/**
 * Formats a focused man page for an individual subcommand.
 */
function formatSubcommandManPage(parentMan, sub) {
	const headerTag = `${parentMan.name.toUpperCase()}-${sub.name.toUpperCase()}(${parentMan.section})`;
	const padLen = Math.max(0, 72 - (headerTag.length * 2) - 16);
	const spaces = ' '.repeat(padLen);
	const header = `${headerTag}${spaces}Soren Manual${spaces}${headerTag}`;

	const lines = [
		'```text',
		header,
		'',
		'NAME',
		`    ${parentMan.name} ${sub.name} - ${sub.description}`,
		'',
		'SYNOPSIS',
		`    ${sub.synopsis}`,
		'',
		'DESCRIPTION',
		`    ${sub.description}`,
	];

	if (sub.options && sub.options.length > 0) {
		lines.push('', 'OPTIONS & ARGUMENTS');
		for (const opt of sub.options) {
			const reqText = opt.required ? 'Required' : 'Optional';
			lines.push(`    ${opt.name} (${reqText}, ${opt.type})`);
			lines.push(`        ${opt.description}`);
		}
	} else {
		lines.push('', 'OPTIONS & ARGUMENTS', '    None.');
	}

	if (parentMan.permissions) {
		lines.push('', 'PERMISSIONS', `    ${parentMan.permissions}`);
	}

	lines.push(
		'',
		'PARENT COMMAND',
		`    ${parentMan.name}(${parentMan.section}) - ${parentMan.summary}`,
		`    Run \`/help command:${parentMan.name}\` for full parent command manual.`
	);

	if (parentMan.seeAlso && parentMan.seeAlso.length > 0) {
		lines.push('', 'SEE ALSO');
		lines.push(`    ${parentMan.seeAlso.join(', ')}`);
	}

	const footerSpaces = ' '.repeat(Math.max(0, 72 - 24 - headerTag.length));
	lines.push(
		'',
		`Soren 1.0.0${footerSpaces}${headerTag}`,
		'```'
	);

	return lines.join('\n');
}

/**
 * Fallback generator for commands registered on the client but not hardcoded in MAN_PAGES.
 */
function formatDynamicCommand(cmd) {
	const json = cmd.data.toJSON ? cmd.data.toJSON() : cmd.data;
	const name = json.name || 'unknown';
	const desc = json.description || 'No description provided.';
	const headerTag = `${name.toUpperCase()}(1)`;
	const padLen = Math.max(0, 72 - (headerTag.length * 2) - 16);
	const spaces = ' '.repeat(padLen);
	const header = `${headerTag}${spaces}Soren Manual${spaces}${headerTag}`;

	const lines = [
		'```text',
		header,
		'',
		'NAME',
		`    ${name} - ${desc}`,
		'',
		'SYNOPSIS',
		`    /${name}`,
		'',
		'DESCRIPTION',
		`    ${desc}`,
	];

	if (json.options && json.options.length > 0) {
		lines.push('', 'OPTIONS / SUBCOMMANDS');
		for (const opt of json.options) {
			lines.push(`    • ${opt.name}: ${opt.description || ''}`);
		}
	}

	lines.push(
		'',
		'SEE ALSO',
		'    help(1)',
		'',
		`Soren 1.0.0                                                     ${headerTag}`,
		'```'
	);

	return lines.join('\n');
}

module.exports = {
	MAN_PAGES,
	formatOverview,
	formatCommandManPage,
	formatSubcommandManPage,
	formatDynamicCommand,

	data: new SlashCommandBuilder()
		.setName('help')
		.setDescription('Display manual pages (man pages) and reference guides for bot commands')
		.addStringOption((option) =>
			option
				.setName('command')
				.setDescription('The command name to view the man page for (omit for manual index)')
				.setRequired(false)
				.addChoices(
					{ name: 'notes - Voice recording, transcription, AI summaries & sync', value: 'notes' },
					{ name: 'notion - Configure and manage Notion workspace integration', value: 'notion' },
					{ name: 'ask - Ask grounded company assistant a question', value: 'ask' },
					{ name: 'join - Join your current voice channel', value: 'join' },
					{ name: 'leave - Leave the current voice channel', value: 'leave' },
					{ name: 'ping - Test bot latency and display user profile', value: 'ping' },
					{ name: 'restart - Restart the bot process (Admin only)', value: 'restart' },
					{ name: 'help - Display manual pages for bot commands', value: 'help' },
				)
		)
		.addStringOption((option) =>
			option
				.setName('subcommand')
				.setDescription('Specific subcommand to view (e.g. start, stop, setup, scan, sync)')
				.setRequired(false)
		),

	async execute(interaction) {
		await interaction.deferReply();

		const commandQuery = interaction.options.getString('command')?.trim().toLowerCase();
		const subcommandQuery = interaction.options.getString('subcommand')?.trim().toLowerCase();

		// Case 1: No command specified -> Show full manual overview and command index
		if (!commandQuery) {
			const overview = formatOverview();
			return sendSafeChunkedReply(interaction, overview, { fileName: 'soren_man_index.md' });
		}

		// Look up command in known MAN_PAGES
		const man = MAN_PAGES[commandQuery];

		if (man) {
			// Case 2: Subcommand specified
			if (subcommandQuery && man.subcommands && man.subcommands.length > 0) {
				const matchedSub = man.subcommands.find(
					(s) => s.name.toLowerCase() === subcommandQuery
				);

				if (matchedSub) {
					const subMan = formatSubcommandManPage(man, matchedSub);
					return sendSafeChunkedReply(interaction, subMan, {
						fileName: `${man.name}_${matchedSub.name}_man_page.md`,
					});
				}

				// Subcommand not found: output notice and fall back to full command man page
				const availableSubs = man.subcommands.map((s) => s.name).join(', ');
				const fullMan = formatCommandManPage(man);
				const combined =
					`**Subcommand \`${subcommandQuery}\` not found for \`/${commandQuery}\`.**\n` +
					`Available subcommands: ${availableSubs}\n\n` +
					fullMan;
				return sendSafeChunkedReply(interaction, combined, {
					fileName: `${man.name}_man_page.md`,
				});
			}

			// Case 3: Top-level command man page
			const fullMan = formatCommandManPage(man);
			return sendSafeChunkedReply(interaction, fullMan, {
				fileName: `${man.name}_man_page.md`,
			});
		}

		// Case 4: Command not in static MAN_PAGES, check client.commands dynamically
		const clientCommand = interaction.client?.commands?.get(commandQuery);
		if (clientCommand && clientCommand.data) {
			const dynamicMan = formatDynamicCommand(clientCommand);
			return sendSafeChunkedReply(interaction, dynamicMan, {
				fileName: `${commandQuery}_man_page.md`,
			});
		}

		// Case 5: Completely unknown command
		const availableCmds = Object.keys(MAN_PAGES).join(', ');
		const notFoundMsg =
			`**No manual entry found for \`${commandQuery}\`.**\n\n` +
			`Available manual pages: ${availableCmds}\n` +
			'Run `/help` without arguments to view the complete Manual Overview.';
		return sendSafeChunkedReply(interaction, notFoundMsg);
	},
};

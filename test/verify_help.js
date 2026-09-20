const assert = require('node:assert');
const {
	data,
	execute,
	MAN_PAGES,
	formatOverview,
	formatCommandManPage,
	formatSubcommandManPage,
	formatDynamicCommand,
} = require('../commands/utility/help');

async function runTests() {
	console.log('🚀 Starting Soren /help Command Verification Suite...\n');
	let passed = 0;
	let failed = 0;

	function test(name, fn) {
		try {
			fn();
			console.log(`  ✅ PASS: ${name}`);
			passed++;
		} catch (err) {
			console.error(`  ❌ FAIL: ${name}`);
			console.error(`     ${err.stack || err.message}`);
			failed++;
		}
	}

	async function asyncTest(name, fn) {
		try {
			await fn();
			console.log(`  ✅ PASS: ${name}`);
			passed++;
		} catch (err) {
			console.error(`  ❌ FAIL: ${name}`);
			console.error(`     ${err.stack || err.message}`);
			failed++;
		}
	}

	// =============================================================
	// Section 1: Command Registration & SlashCommandBuilder Schema
	// =============================================================
	console.log('--- [Section 1] SlashCommandBuilder Definition ---');
	test('help command has correct metadata', () => {
		assert.strictEqual(data.name, 'help');
		assert.ok(data.description.length > 0, 'Must have description');
		const json = data.toJSON();
		assert.strictEqual(json.name, 'help');
		assert.strictEqual(json.options.length, 2);

		const cmdOpt = json.options.find((o) => o.name === 'command');
		assert.ok(cmdOpt, 'Should have "command" option');
		assert.strictEqual(cmdOpt.required, false);
		assert.ok(cmdOpt.choices.length >= 8, 'Should have choices for all bot commands');

		const expectedChoices = ['notes', 'notion', 'ask', 'join', 'leave', 'ping', 'restart', 'help'];
		for (const exp of expectedChoices) {
			assert.ok(
				cmdOpt.choices.some((c) => c.value === exp),
				`Choice list should include ${exp}`
			);
		}

		const subOpt = json.options.find((o) => o.name === 'subcommand');
		assert.ok(subOpt, 'Should have "subcommand" option');
		assert.strictEqual(subOpt.required, false);
	});

	// =============================================================
	// Section 2: Manual Overview Formatting
	// =============================================================
	console.log('--- [Section 2] Manual Overview (Table of Contents) ---');
	test('formatOverview renders standard UNIX manual structure', () => {
		const overview = formatOverview();
		assert.ok(overview.startsWith('```text\nSOREN(1)'), 'Should begin with SOREN(1) man header');
		assert.ok(overview.endsWith('```'), 'Should close code block');
		assert.ok(overview.includes('NAME'), 'Must contain NAME section');
		assert.ok(overview.includes('SYNOPSIS'), 'Must contain SYNOPSIS section');
		assert.ok(overview.includes('DESCRIPTION'), 'Must contain DESCRIPTION section');
		assert.ok(overview.includes('MANUAL SECTIONS & COMMAND INDEX'), 'Must contain section index');
		assert.ok(overview.includes('notes(1)'), 'Must list notes command');
		assert.ok(overview.includes('notion(8)'), 'Must list notion command');
		assert.ok(overview.includes('ask(1)'), 'Must list ask command');
		assert.ok(overview.includes('join(1)'), 'Must list join command');
		assert.ok(overview.includes('leave(1)'), 'Must list leave command');
		assert.ok(overview.includes('ping(1)'), 'Must list ping command');
		assert.ok(overview.includes('restart(8)'), 'Must list restart command');
		assert.ok(overview.includes('help(1)'), 'Must list help command');
		assert.ok(overview.includes('@Soren <question>'), 'Must document chat mention syntax');
	});

	// =============================================================
	// Section 3: All Command Man Pages
	// =============================================================
	console.log('--- [Section 3] Individual Command Man Pages ---');
	const allCommandKeys = ['ping', 'ask', 'join', 'leave', 'restart', 'notion', 'notes', 'help'];

	for (const cmdKey of allCommandKeys) {
		test(`MAN_PAGES entry for /${cmdKey} is complete and formats properly`, () => {
			const man = MAN_PAGES[cmdKey];
			assert.ok(man, `MAN_PAGES must have entry for ${cmdKey}`);
			assert.strictEqual(man.name, cmdKey);
			assert.ok(man.section === 1 || man.section === 8, 'Section must be 1 or 8');
			assert.ok(man.summary.length > 0, 'Must have summary');
			assert.ok(man.synopsis.length > 0, 'Must have synopsis');
			assert.ok(man.description.length > 0, 'Must have description');
			assert.ok(man.permissions.length > 0, 'Must specify permissions');

			const formatted = formatCommandManPage(man);
			assert.ok(formatted.startsWith('```text'), 'Formatted output must start with code fence');
			assert.ok(formatted.endsWith('```'), 'Formatted output must end with code fence');
			assert.ok(formatted.includes(`NAME\n    ${man.name} - ${man.summary}`), 'Must include formatted NAME block');
			assert.ok(formatted.includes('SYNOPSIS'), 'Must include SYNOPSIS block');
			assert.ok(formatted.includes('DESCRIPTION'), 'Must include DESCRIPTION block');
			assert.ok(formatted.includes('PERMISSIONS & ACCESS'), 'Must include PERMISSIONS block');
		});
	}

	test('notes man page documents all 17 subcommands', () => {
		const notesMan = MAN_PAGES.notes;
		assert.strictEqual(notesMan.subcommands.length, 17);
		const subNames = notesMan.subcommands.map((s) => s.name);
		const expectedSubs = [
			'start', 'stop', 'channel', 'setkey', 'setmodel', 'clearkey',
			'keyinfo', 'stats', 'setnotion', 'notioninfo', 'clearnotion',
			'notionprovision', 'createhub', 'syncmode', 'sync', 'ask', 'audit',
		];
		for (const expSub of expectedSubs) {
			assert.ok(subNames.includes(expSub), `notes subcommands must include ${expSub}`);
		}
	});

	test('notion man page documents all 4 subcommands', () => {
		const notionMan = MAN_PAGES.notion;
		assert.strictEqual(notionMan.subcommands.length, 4);
		const subNames = notionMan.subcommands.map((s) => s.name);
		const expectedSubs = ['setup', 'scan', 'status', 'link-member'];
		for (const expSub of expectedSubs) {
			assert.ok(subNames.includes(expSub), `notion subcommands must include ${expSub}`);
		}
	});

	// =============================================================
	// Section 4: Subcommand Man Page Formatting
	// =============================================================
	console.log('--- [Section 4] Subcommand Drilldown Formatting ---');
	test('formatSubcommandManPage renders focused man page for /notes start', () => {
		const startSub = MAN_PAGES.notes.subcommands.find((s) => s.name === 'start');
		const formatted = formatSubcommandManPage(MAN_PAGES.notes, startSub);
		assert.ok(formatted.includes('NOTES-START(1)'));
		assert.ok(formatted.includes('SYNOPSIS\n    /notes start [provider:<groq|gemini>] [model:<string>]'));
		assert.ok(formatted.includes('OPTIONS & ARGUMENTS'));
		assert.ok(formatted.includes('provider (Optional, String)'));
		assert.ok(formatted.includes('model (Optional, String)'));
		assert.ok(formatted.includes('PARENT COMMAND\n    notes(1)'));
	});

	test('formatSubcommandManPage renders focused man page for /notion setup', () => {
		const setupSub = MAN_PAGES.notion.subcommands.find((s) => s.name === 'setup');
		const formatted = formatSubcommandManPage(MAN_PAGES.notion, setupSub);
		assert.ok(formatted.includes('NOTION-SETUP(8)'));
		assert.ok(formatted.includes('token (Required, String)'));
		assert.ok(formatted.includes('wiki_page_id (Required, String)'));
		assert.ok(formatted.includes('PARENT COMMAND\n    notion(8)'));
	});

	// =============================================================
	// Section 5: Dynamic Fallback Formatting
	// =============================================================
	console.log('--- [Section 5] Dynamic Command Generator ---');
	test('formatDynamicCommand formats unregistered SlashCommandBuilder', () => {
		const mockCmd = {
			data: {
				toJSON() {
					return {
						name: 'customcmd',
						description: 'Custom plugin command',
						options: [{ name: 'opt1', description: 'Option one' }],
					};
				},
			},
		};
		const formatted = formatDynamicCommand(mockCmd);
		assert.ok(formatted.includes('CUSTOMCMD(1)'));
		assert.ok(formatted.includes('/customcmd'));
		assert.ok(formatted.includes('Custom plugin command'));
		assert.ok(formatted.includes('opt1: Option one'));
	});

	// =============================================================
	// Section 6: Interaction Execution
	// =============================================================
	console.log('--- [Section 6] Interaction Execution Paths ---');

	function createMockInteraction(command, subcommand) {
		const replies = [];
		const followUps = [];
		let deferred = false;

		return {
			options: {
				getString(key) {
					if (key === 'command') return command || null;
					if (key === 'subcommand') return subcommand || null;
					return null;
				},
			},
			client: {
				commands: new Map(),
			},
			async deferReply() {
				deferred = true;
			},
			async editReply(payload) {
				replies.push(payload);
				return payload;
			},
			async followUp(payload) {
				followUps.push(payload);
				return payload;
			},
			get replies() {
				return replies;
			},
			get followUps() {
				return followUps;
			},
			get wasDeferred() {
				return deferred;
			},
		};
	}

	await asyncTest('executing /help with no args returns overview', async () => {
		const mock = createMockInteraction();
		await execute(mock);
		assert.ok(mock.wasDeferred);
		assert.strictEqual(mock.replies.length, 1);
		assert.ok(mock.replies[0].content.includes('SOREN(1)'));
		assert.ok(mock.replies[0].content.includes('MANUAL SECTIONS & COMMAND INDEX'));
	});

	await asyncTest('executing /help command:notes returns notes man page', async () => {
		const mock = createMockInteraction('notes');
		await execute(mock);
		assert.ok(mock.wasDeferred);
		const allContent = [mock.replies[0].content, ...mock.followUps.map((f) => f.content)].join('\n');
		assert.ok(allContent.includes('NOTES(1)'));
		assert.ok(allContent.includes('/notes start'));
	});

	await asyncTest('executing /help command:notes subcommand:start returns subcommand man page', async () => {
		const mock = createMockInteraction('notes', 'start');
		await execute(mock);
		assert.ok(mock.wasDeferred);
		assert.ok(mock.replies[0].content.includes('NOTES-START(1)'));
		assert.ok(mock.replies[0].content.includes('provider (Optional, String)'));
	});

	await asyncTest('executing /help command:notes subcommand:invalid informs user of valid subcommands', async () => {
		const mock = createMockInteraction('notes', 'fly');
		await execute(mock);
		assert.ok(mock.wasDeferred);
		const allContent = [mock.replies[0].content, ...mock.followUps.map((f) => f.content)].join('\n');
		assert.ok(allContent.includes('Subcommand `fly` not found for `/notes`.'));
		assert.ok(allContent.includes('NOTES(1)'));
	});

	await asyncTest('executing /help command:unknownCmd shows not found message and lists commands', async () => {
		const mock = createMockInteraction('nonexistent');
		await execute(mock);
		assert.ok(mock.wasDeferred);
		assert.ok(mock.replies[0].content.includes('No manual entry found for `nonexistent`.'));
		for (const key of Object.keys(MAN_PAGES)) {
			assert.ok(mock.replies[0].content.includes(key), `Should mention ${key}`);
		}
	});

	await asyncTest('executing /help with unregistered command in client.commands uses dynamic fallback', async () => {
		const mock = createMockInteraction('myplugin');
		mock.client.commands.set('myplugin', {
			data: {
				toJSON() {
					return {
						name: 'myplugin',
						description: 'Third-party dynamic plugin',
						options: [],
					};
				},
			},
		});
		await execute(mock);
		assert.ok(mock.wasDeferred);
		assert.ok(mock.replies[0].content.includes('MYPLUGIN(1)'));
		assert.ok(mock.replies[0].content.includes('Third-party dynamic plugin'));
	});

	console.log(`\n======================================================`);
	console.log(`📊 Help Command Test Summary: ${passed} Passed, ${failed} Failed`);
	console.log(`======================================================\n`);

	if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
	console.error('Fatal error in test suite:', err);
	process.exit(1);
});

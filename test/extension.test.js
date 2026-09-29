const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
const vscode = require('vscode');
const EXTENSION_CONFIG = require('../config.json');
const { activateOnTriggers } = require('../feature-lifecycle');
const {
	hasAlWorkspace,
	createApplicationRegistration,
	parseAlObjects,
	isObjectIdInRanges,
	classifyObjectSyncStatus,
	getApplicationObjectStatuses,
	checkAndUploadApplicationObject
} = require('../extension');

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('Activates and disposes features from lifecycle triggers', async () => {
		let enabled = false;
		let startCount = 0;
		let stopCount = 0;
		let triggerDisposed = false;
		/** @type {Array<() => void>} */
		const listeners = [];
		const lifecycle = activateOnTriggers([
			(listener) => {
				listeners.push(listener);
				return { dispose: () => { triggerDisposed = true; } };
			}
		], async () => enabled, () => startCount++, () => stopCount++);
		const flushLifecycleCheck = () => new Promise((resolve) => setImmediate(resolve));

		await flushLifecycleCheck();
		assert.strictEqual(startCount, 0);
		enabled = true;
		listeners[0]();
		await flushLifecycleCheck();
		assert.strictEqual(startCount, 1);
		enabled = false;
		listeners[0]();
		await flushLifecycleCheck();
		assert.strictEqual(stopCount, 1);

		lifecycle.dispose();
		assert.strictEqual(triggerDisposed, true);
	});

	test('Only accepts AL app manifests with a GUID id', async () => {
		const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'object-manager-'));
		const workspaceFolders = [{
			uri: vscode.Uri.file(workspacePath),
			name: path.basename(workspacePath),
			index: 0
		}];
		try {
			assert.strictEqual(await hasAlWorkspace(workspaceFolders), false);

			await fs.writeFile(path.join(workspacePath, 'app.json'), '{');
			assert.strictEqual(await hasAlWorkspace(workspaceFolders), false);

			await fs.writeFile(path.join(workspacePath, 'app.json'), JSON.stringify({ id: '' }));
			assert.strictEqual(await hasAlWorkspace(workspaceFolders), false);

			await fs.writeFile(path.join(workspacePath, 'app.json'), JSON.stringify({
				id: '01234567-89ab-cdef-0123-456789abcdef'
			}));
			assert.strictEqual(await hasAlWorkspace(workspaceFolders), true);
		} finally {
			await fs.rm(workspacePath, { recursive: true, force: true });
		}
	});

	test('Builds a range registration from app.json fields', () => {
		const manifest = {
			id: '01234567-89ab-cdef-0123-456789abcdef',
			name: 'Example App',
			publisher: 'Example Publisher',
			idRanges: [{ from: 50000, to: 50099 }]
		};

		assert.deepStrictEqual(createApplicationRegistration(manifest), {
			id: manifest.id,
			name: manifest.name,
			publisher: manifest.publisher,
			ranges: manifest.idRanges
		});
	});

	test('Finds supported AL objects in files with comments and namespaces', () => {
		const source = `// table 1 IgnoredLineComment
/*
page 2 IgnoredBlockComment
*/
namespace System.Reflection;

table 2000000001 "Object Metadata"
{
}

page 50100 CustomerCard
{
}

report 50101 "Annual Report" {}
codeunit 50102 Handler {}
xmlport 50103 ImportData {}
menusuite 50104 MainMenu {}
query 50105 CustomerQuery {}`;

		assert.deepStrictEqual(parseAlObjects(source), [
			{ 'object type': 'Table', 'object name': 'Object Metadata', 'object id': '2000000001' },
			{ 'object type': 'Page', 'object name': 'CustomerCard', 'object id': '50100' },
			{ 'object type': 'Report', 'object name': 'Annual Report', 'object id': '50101' },
			{ 'object type': 'Codeunit', 'object name': 'Handler', 'object id': '50102' },
			{ 'object type': 'XMLport', 'object name': 'ImportData', 'object id': '50103' },
			{ 'object type': 'MenuSuite', 'object name': 'MainMenu', 'object id': '50104' },
			{ 'object type': 'Query', 'object name': 'CustomerQuery', 'object id': '50105' }
		]);
	});

	test('Checks object IDs against inclusive app ranges', () => {
		const ranges = [{ from: 50000, to: 50099 }, { from: 60000, to: 60010 }];

		assert.strictEqual(isObjectIdInRanges('50000', ranges), true);
		assert.strictEqual(isObjectIdInRanges('50099', ranges), true);
		assert.strictEqual(isObjectIdInRanges('50100', ranges), false);
		assert.strictEqual(isObjectIdInRanges('60010', ranges), true);
		assert.strictEqual(isObjectIdInRanges('1', undefined), false);
	});

	test('Classifies local object reservation sync states', () => {
		const object = {
			'object type': 'Page',
			'object name': 'CustomerCard',
			'object id': '50010'
		};
		const ranges = [{ from: 50000, to: 50099 }];
		const reservation = { name: 'CustomerCard' };

		assert.strictEqual(classifyObjectSyncStatus(object, ranges, reservation), 'synced');
		assert.strictEqual(classifyObjectSyncStatus(object, ranges, undefined), 'unsynced');
		assert.strictEqual(classifyObjectSyncStatus(object, ranges, {
			...reservation,
			name: 'DifferentName'
		}), 'conflict');
		assert.strictEqual(classifyObjectSyncStatus(object, [], reservation), 'outOfRange');
	});

	test('Loads reservations from object type folders and treats missing folders as empty', async () => {
		const originalFetch = global.fetch;
		const repositoryUrl = `${EXTENSION_CONFIG.github.apiUrl}/repos/example/${EXTENSION_CONFIG.rangeRepository.name}`;
		const object = {
			'object type': 'Page',
			'object name': 'CustomerCard',
			'object id': '50010'
		};
		/** @type {string[]} */
		const requests = [];
		try {
			global.fetch = async (url) => {
				const requestUrl = String(url);
				requests.push(requestUrl);
				if (requestUrl.includes('/object-reservations/page?ref=')) {
					return new Response(JSON.stringify([{
						type: 'file',
						name: 'Page_50010.json',
						url: `${repositoryUrl}/contents/${EXTENSION_CONFIG.rangeRepository.objectReservationsDirectory}/page/Page_50010.json`
					}]), { status: 200 });
				}
				if (requestUrl.includes('/object-reservations/report?ref=')) {
					return new Response('Not Found', { status: 404 });
				}
				const reservation = { name: 'CustomerCard' };
				return new Response(JSON.stringify({
					content: Buffer.from(JSON.stringify(reservation)).toString('base64')
				}), { status: 200 });
			};

			const statuses = await getApplicationObjectStatuses(
				repositoryUrl,
				[object, { ...object, 'object type': 'Report', 'object id': '50011' }],
				[{ from: 50000, to: 50099 }],
				{}
			);

			assert.ok(requests[0].includes(`/contents/${EXTENSION_CONFIG.rangeRepository.objectReservationsDirectory}/page?ref=${EXTENSION_CONFIG.rangeRepository.branch}`));
			assert.ok(requests.some((url) => url.includes(`/contents/${EXTENSION_CONFIG.rangeRepository.objectReservationsDirectory}/report?ref=${EXTENSION_CONFIG.rangeRepository.branch}`)));
			assert.deepStrictEqual(statuses.map(({ status }) => status), ['synced', 'unsynced']);
		} finally {
			global.fetch = originalFetch;
		}
	});

	test('Uploads the exact reservation file only after a fresh conflict check', async () => {
		const originalFetch = global.fetch;
		const repositoryUrl = `${EXTENSION_CONFIG.github.apiUrl}/repos/example/${EXTENSION_CONFIG.rangeRepository.name}`;
		const object = {
			'object type': 'Page',
			'object name': 'CustomerCard',
			'object id': '50010'
		};
		/** @type {{ url: string, options: RequestInit }[]} */
		const requests = [];
		try {
			global.fetch = async (url, options = {}) => {
				requests.push({ url: String(url), options });
				return options.method === 'PUT'
					? new Response('{}', { status: 201 })
					: new Response('[]', { status: 200 });
			};

			const status = await checkAndUploadApplicationObject(
				repositoryUrl,
				object,
				[{ from: 50000, to: 50099 }],
				{}
			);

			assert.strictEqual(status, 'synced');
			assert.strictEqual(requests.length, 2);
			assert.ok(requests[0].url.endsWith(`/${EXTENSION_CONFIG.rangeRepository.objectReservationsDirectory}/page?ref=${EXTENSION_CONFIG.rangeRepository.branch}`));
			assert.ok(requests[1].url.endsWith(`/${EXTENSION_CONFIG.rangeRepository.objectReservationsDirectory}/page/page50010`));
			const payload = JSON.parse(/** @type {string} */ (requests[1].options.body));
			const reservation = JSON.parse(Buffer.from(payload.content, 'base64').toString('utf8'));
			assert.strictEqual(reservation.name, 'CustomerCard');
			assert.strictEqual(new Date(reservation.timestamp).toISOString(), reservation.timestamp);
			assert.strictEqual(reservation.repo, repositoryUrl);
		} finally {
			global.fetch = originalFetch;
		}
	});

	test('Does not overwrite a conflicting reservation during sync action', async () => {
		const originalFetch = global.fetch;
		const repositoryUrl = `${EXTENSION_CONFIG.github.apiUrl}/repos/example/${EXTENSION_CONFIG.rangeRepository.name}`;
		const object = {
			'object type': 'Page',
			'object name': 'CustomerCard',
			'object id': '50010'
		};
		let requestCount = 0;
		try {
			global.fetch = async () => {
				requestCount++;
				if (requestCount === 1) {
					return new Response(JSON.stringify([{
						type: 'file',
						name: 'Page50010',
						url: `${repositoryUrl}/contents/${EXTENSION_CONFIG.rangeRepository.objectReservationsDirectory}/page/Page50010`
					}]), { status: 200 });
				}
				return new Response(JSON.stringify({
					content: Buffer.from(JSON.stringify({ name: 'DifferentName' })).toString('base64')
				}), { status: 200 });
			};

			const status = await checkAndUploadApplicationObject(
				repositoryUrl,
				object,
				[{ from: 50000, to: 50099 }],
				{}
			);

			assert.strictEqual(status, 'conflict');
			assert.strictEqual(requestCount, 2);
		} finally {
			global.fetch = originalFetch;
		}
	});
});

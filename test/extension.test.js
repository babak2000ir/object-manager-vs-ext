const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
const vscode = require('vscode');
const EXTENSION_CONFIG = require('../config.json');
const { activateOnTriggers } = require('../feature-lifecycle');
const { ExtensionUsageDataProvider, OrganizationUsageDataProvider } = require('../tree-data-providers');
const {
	hasAlWorkspace,
	createApplicationRegistration,
	areRangesEqual,
	parseAlObjects,
	isObjectIdInRanges,
	getNextAvailableObjectId,
	getObjectIdSlot,
	getDuplicateObjectKeys,
	classifyObjectSyncStatus,
	getApplicationObjectStatuses,
	getObjectValidationFailures,
	analyzeRepositoryBranchObjects,
	getGithubOwnerFromRemote,
	syncUnsyncedApplicationObjects,
	startValidationServer,
	prepareGitHookInstallation,
	installGitValidationHooksForRepository,
	checkAndUploadApplicationObject,
	upsertApplicationObjectReservation,
	forceApplicationRangeToRepositoryData
} = require('../extension');

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('Finds GitHub owners in common remote URL formats only', () => {
		assert.strictEqual(getGithubOwnerFromRemote('https://github.com/Contoso/app.git'), 'Contoso');
		assert.strictEqual(getGithubOwnerFromRemote('git@github.com:Contoso/app.git'), 'Contoso');
		assert.strictEqual(getGithubOwnerFromRemote('ssh://git@github.com/Contoso/app'), 'Contoso');
		assert.strictEqual(getGithubOwnerFromRemote('https://gitlab.com/Contoso/app.git'), undefined);
		assert.strictEqual(getGithubOwnerFromRemote('https://github.com/Contoso/app/extra'), undefined);
		assert.strictEqual(getGithubOwnerFromRemote('not a remote URL'), undefined);
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

	test('Compares application ranges without depending on their order', () => {
		assert.strictEqual(areRangesEqual(
			[{ from: 50000, to: 50099 }, { from: 60000, to: 60099 }],
			[{ from: 60000, to: 60099 }, { from: 50000, to: 50099 }]
		), true);
		assert.strictEqual(areRangesEqual([{ from: 50000, to: 50099 }], [{ from: 50000, to: 50100 }]), false);
	});

	test('Marks app.json ranges and adds the inline action when ranges differ', async () => {
		const provider = new OrganizationUsageDataProvider(async () => true);
		provider.setRangeData('example', {
			Remarks: [],
			ranges: [{
				id: 'target',
				name: 'Target',
				publisher: 'Publisher',
				ranges: [{ from: 51000, to: 51099 }]
			}]
		}, {
			id: 'target',
			ranges: [{ from: 50000, to: 50099 }]
		});

		const root = (await provider.getChildren())[0];
		assert.ok(root);
		const [registration] = root.children ?? [];
		assert.ok(registration);
		const [applicationRange, repositoryRange] = registration.children ?? [];
		assert.ok(applicationRange);
		assert.ok(repositoryRange);
		assert.strictEqual(applicationRange.label, 'app.json: 50000-50099');
		assert.strictEqual(applicationRange.syncStatus, 'outOfRange');
		assert.strictEqual(applicationRange.contextValue, 'mismatchedApplicationRange');
		assert.strictEqual(applicationRange.rangeOwner, 'example');
		assert.strictEqual(applicationRange.applicationId, 'target');
		assert.strictEqual(repositoryRange.label, 'data.json: 51000-51099');
		const applicationIcon = provider.getTreeItem(applicationRange).iconPath;
		assert.ok(applicationIcon);
		const applicationIconId = typeof applicationIcon === 'string'
			? applicationIcon
			: 'id' in applicationIcon ? applicationIcon.id : undefined;
		assert.strictEqual(applicationIconId, 'close');

		provider.setRangeSyncing('example', 'target', true);
		const busyRoot = (await provider.getChildren())[0];
		assert.ok(busyRoot);
		const [busyRegistration] = busyRoot.children ?? [];
		assert.ok(busyRegistration);
		const [busyApplicationRange] = busyRegistration.children ?? [];
		assert.ok(busyApplicationRange);
		assert.strictEqual(busyApplicationRange.contextValue, 'forcingApplicationRange');

		provider.setRangeData('example', {
			Remarks: [],
			ranges: [{
				id: 'target',
				name: 'Target',
				publisher: 'Publisher',
				ranges: [{ from: 50000, to: 50099 }]
			}]
		}, {
			id: 'target',
			ranges: [{ from: 50000, to: 50099 }]
		});
		const matchingRoot = (await provider.getChildren())[0];
		assert.ok(matchingRoot);
		const [matchingRegistration] = matchingRoot.children ?? [];
		assert.ok(matchingRegistration);
		const [matchingApplicationRange] = matchingRegistration.children ?? [];
		assert.ok(matchingApplicationRange);
		assert.strictEqual(matchingApplicationRange.syncStatus, 'synced');
		const matchingIcon = provider.getTreeItem(matchingApplicationRange).iconPath;
		assert.ok(matchingIcon);
		const matchingIconId = typeof matchingIcon === 'string'
			? matchingIcon
			: 'id' in matchingIcon ? matchingIcon.id : undefined;
		assert.strictEqual(matchingIconId, 'check');
		assert.strictEqual(matchingApplicationRange.contextValue, undefined);
	});

	test('Forces only the selected registration range into data.json', async () => {
		const originalFetch = global.fetch;
		const originalData = {
			Remarks: ['Keep this remark'],
			ranges: [
				{ id: 'target', name: 'Target', publisher: 'Publisher', ranges: [{ from: 51000, to: 51099 }] },
				{ id: 'other', name: 'Other', publisher: 'Publisher', ranges: [{ from: 52000, to: 52099 }] }
			]
		};
		/** @type {{ url: string, options: RequestInit }[]} */
		const requests = [];
		try {
			global.fetch = async (url, options = {}) => {
				requests.push({ url: String(url), options });
				if (options.method === 'PUT') {
					return new Response('{}', { status: 200 });
				}
				return new Response(JSON.stringify({
					content: Buffer.from(JSON.stringify(originalData)).toString('base64'),
					sha: 'current-sha'
				}), { status: 200 });
			};

			const changed = await forceApplicationRangeToRepositoryData('example', {
				id: 'target',
				name: 'Target',
				publisher: 'Publisher',
				ranges: [{ from: 50000, to: 50099 }]
			}, {});

			assert.strictEqual(changed, true);
			assert.strictEqual(requests.length, 2);
			assert.ok(requests[1].options.body);
			const update = JSON.parse(String(requests[1].options.body));
			const updatedData = JSON.parse(Buffer.from(update.content, 'base64').toString('utf8'));
			assert.strictEqual(update.sha, 'current-sha');
			assert.deepStrictEqual(updatedData.Remarks, originalData.Remarks);
			assert.deepStrictEqual(updatedData.ranges[0].ranges, [{ from: 50000, to: 50099 }]);
			assert.deepStrictEqual(updatedData.ranges[1], originalData.ranges[1]);
		} finally {
			global.fetch = originalFetch;
		}
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

	test('Suggests the first unused ID in app ranges for each object type', () => {
		const objects = [
			{ 'object type': 'Page', 'object name': 'First', 'object id': '50000' },
			{ 'object type': 'Page', 'object name': 'Third', 'object id': '50002' },
			{ 'object type': 'Table', 'object name': 'FirstTable', 'object id': '50000' }
		];
		const ranges = [{ from: 50000, to: 50002 }, { from: 60000, to: 60001 }];

		assert.strictEqual(getNextAvailableObjectId('Page', objects, ranges), '50001');
		assert.strictEqual(getNextAvailableObjectId('Table', objects, ranges), '50001');
		assert.strictEqual(getNextAvailableObjectId('Report', objects, ranges), '50000');
		assert.strictEqual(getNextAvailableObjectId('Page', [
			...objects,
			{ 'object type': 'Page', 'object name': 'Second', 'object id': '50001' }
		], ranges), '60000');
		assert.strictEqual(getNextAvailableObjectId('Page', objects, []), undefined);
		assert.strictEqual(getNextAvailableObjectId('Page', [
			...objects,
			{ 'object type': 'Page', 'object name': 'Unsynced', 'object id': '50001' }
		], ranges), '60000');

		const provider = new ExtensionUsageDataProvider();
		provider.setObjects(objects, ranges);
		assert.strictEqual(provider.getNextAvailableObjectId('Page'), '50001');
		assert.strictEqual(provider.getNextAvailableObjectId('Report'), '50000');
	});

	test('Marks repeated local IDs of the same object type as conflicts', async () => {
		const duplicateObjects = [
			{ 'object type': 'Page', 'object name': 'FirstPage', 'object id': '50000' },
			{ 'object type': 'Page', 'object name': 'SecondPage', 'object id': '50000' },
			{ 'object type': 'Table', 'object name': 'FirstTable', 'object id': '50000' }
		];
		const duplicateKeys = getDuplicateObjectKeys(duplicateObjects);
		assert.deepStrictEqual([...duplicateKeys], ['Page:50000']);

		const provider = new ExtensionUsageDataProvider();
		provider.setObjects(duplicateObjects, [{ from: 50000, to: 50010 }]);
		assert.deepStrictEqual(provider.objects.map(({ syncStatus }) => syncStatus), [
			'conflict', 'conflict', 'checking'
		]);
		provider.setSyncStatuses(duplicateObjects.map((object) => ({ object, status: 'synced' })));
		assert.deepStrictEqual(provider.objects.map(({ syncStatus }) => syncStatus), [
			'conflict', 'conflict', 'synced'
		]);

		const duplicateStatuses = await getApplicationObjectStatuses(
			'https://example.test/repository',
			duplicateObjects.slice(0, 2),
			[{ from: 50000, to: 50010 }],
			{}
		);
		assert.deepStrictEqual(duplicateStatuses.map(({ status }) => status), ['conflict', 'conflict']);
	});

	test('Identifies only the object ID slot in an AL declaration', () => {
		assert.deepStrictEqual(getObjectIdSlot('    page 50001 "Customer Card"', 13), {
			objectType: 'Page',
			start: 9,
			end: 14
		});
		assert.deepStrictEqual(getObjectIdSlot('table   ', 8), {
			objectType: 'Table',
			start: 8,
			end: 8
		});
		assert.strictEqual(getObjectIdSlot('page 50001 "Customer Card"', 20), undefined);
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

	test('Blocks validation only for conflicting or out-of-range objects', () => {
		const object = { 'object type': 'Page', 'object name': 'CustomerCard', 'object id': '50010' };
		const ranges = [{ from: 50000, to: 50099 }];
		const statuses = [
			{ object, status: classifyObjectSyncStatus(object, ranges, { name: 'CustomerCard' }) },
			{ object, status: classifyObjectSyncStatus(object, ranges, undefined) },
			{ object, status: classifyObjectSyncStatus(object, ranges, { name: 'DifferentName' }) },
			{ object, status: classifyObjectSyncStatus(object, [], { name: 'CustomerCard' }) }
		];
		assert.deepStrictEqual(
			getObjectValidationFailures(statuses).map(({ status }) => status),
			['conflict', 'outOfRange']
		);
	});

	test('Reports conflicts on other branches and syncs the current-branch object version', () => {
		const currentObject = { 'object type': 'Page', 'object name': 'CustomerCard', 'object id': '50010' };
		const branches = [
			{ name: 'main', isCurrent: true, objects: [currentObject] },
			{ name: 'feature/rename', isCurrent: false, objects: [
				{ ...currentObject, 'object name': 'CustomerList' },
				{ 'object type': 'Table', 'object name': 'OutsideRange', 'object id': '60000' },
				{ 'object type': 'Report', 'object name': 'SalesReport', 'object id': '50011' }
			] }
		];

		const analysis = analyzeRepositoryBranchObjects(branches, [{ from: 50000, to: 50099 }]);

		assert.deepStrictEqual(analysis.conflicts.map(({ branch, object, reason }) => [
			branch, object['object id'], reason
		]), [
			['feature/rename', '60000', 'outOfRange'],
			['feature/rename', '50010', 'conflict']
		]);
		assert.deepStrictEqual(analysis.objects, [
			currentObject,
			{ 'object type': 'Report', 'object name': 'SalesReport', 'object id': '50011' }
		]);
		assert.strictEqual(analysis.syncableObjectKeys.has('Page:50010'), true);
	});

	test('Updates a same-name reservation file with its current SHA', async () => {
		const originalFetch = global.fetch;
		const repositoryUrl = `${EXTENSION_CONFIG.github.apiUrl}/repos/example/${EXTENSION_CONFIG.rangeRepository.name}`;
		const object = { 'object type': 'Page', 'object name': 'CustomerCard', 'object id': '50010' };
		/** @type {{ url: string, options: RequestInit }[]} */
		const requests = [];
		try {
			global.fetch = async (url, options = {}) => {
				requests.push({ url: String(url), options });
				if (options.method === 'PUT') {
					return new Response('{}', { status: 200 });
				}
				if (String(url).includes('?ref=')) {
					return new Response(JSON.stringify([{
						type: 'file',
						name: 'Page50010.json',
						url: `${repositoryUrl}/contents/${EXTENSION_CONFIG.rangeRepository.objectReservationsDirectory}/page/Page50010.json`
					}]), { status: 200 });
				}
				return new Response(JSON.stringify({
					sha: 'current-sha',
					content: Buffer.from(JSON.stringify({ name: 'CustomerCard' })).toString('base64')
				}), { status: 200 });
			};

			assert.strictEqual(await upsertApplicationObjectReservation(
				repositoryUrl,
				object,
				[{ from: 50000, to: 50099 }],
				{}
			), 'synced');
			assert.strictEqual(requests.length, 3);
			const update = JSON.parse(String(requests[2].options.body));
			assert.ok(requests[2].url.endsWith('/page/Page50010.json'));
			assert.strictEqual(update.sha, 'current-sha');
			assert.strictEqual(update.branch, EXTENSION_CONFIG.rangeRepository.branch);
			assert.strictEqual(JSON.parse(Buffer.from(update.content, 'base64').toString('utf8')).name, 'CustomerCard');
		} finally {
			global.fetch = originalFetch;
		}
	});

	test('Requires authorization and blocks Git hooks when validation fails', async () => {
		const server = await startValidationServer(async () => ({ ok: false, message: 'Resolve the reservation conflict.' }));
		try {
			const unauthorizedResponse = await fetch(server.url, { method: 'POST' });
			assert.strictEqual(unauthorizedResponse.status, 403);

			const validationResponse = await fetch(server.url, {
				method: 'POST',
				headers: { Authorization: `Bearer ${server.token}` }
			});
			assert.strictEqual(validationResponse.status, 409);
			assert.deepStrictEqual(await validationResponse.json(), {
				ok: false,
				message: 'Resolve the reservation conflict.'
			});
		} finally {
			server.dispose();
		}
	});

	test('Installed commit and push hooks block Git when validation fails', async () => {
		const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'object-manager-hooks-'));
		const server = await startValidationServer(async () => ({ ok: false, message: 'Resolve the out-of-range object.' }));
		try {
			await execFileAsync('git', ['init', '--quiet'], { cwd: repositoryPath });
			const installation = await prepareGitHookInstallation({ rootUri: vscode.Uri.file(repositoryPath) });
			await installGitValidationHooksForRepository(installation, server);

			for (const hookName of ['pre-commit', 'pre-push']) {
				await assert.rejects(
					execFileAsync('git', ['hook', 'run', hookName], { cwd: repositoryPath }),
					(error) => {
						const gitError = /** @type {NodeJS.ErrnoException & { stderr?: string | Buffer }} */ (error);
						return String(gitError.code) === '1' && String(gitError.stderr ?? '').includes('Resolve the out-of-range object.');
					}
				);
			}
			server.dispose();
			await assert.rejects(
				execFileAsync('git', ['hook', 'run', 'pre-commit'], { cwd: repositoryPath }),
				(error) => String(/** @type {NodeJS.ErrnoException} */ (error).code) === '1'
			);
		} finally {
			server.dispose();
			await fs.rm(repositoryPath, { recursive: true, force: true });
		}
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

	test('Uploads every unsynced reservation and leaves synced or out-of-range objects alone', async () => {
		const originalFetch = global.fetch;
		const repositoryUrl = `${EXTENSION_CONFIG.github.apiUrl}/repos/example/${EXTENSION_CONFIG.rangeRepository.name}`;
		const objects = [
			{ 'object type': 'Table', 'object name': 'Customer', 'object id': '50001' },
			{ 'object type': 'Page', 'object name': 'CustomerCard', 'object id': '50002' },
			{ 'object type': 'Report', 'object name': 'SalesReport', 'object id': '50003' },
			{ 'object type': 'Codeunit', 'object name': 'Handler', 'object id': '50004' }
		];
		const ranges = [{ from: 50000, to: 50099 }];
		const statuses = /** @type {Parameters<typeof syncUnsyncedApplicationObjects>[1]} */ ([]);
		statuses.push(
			{ object: objects[0], status: classifyObjectSyncStatus(objects[0], ranges, { name: 'Customer' }) },
			{ object: objects[1], status: classifyObjectSyncStatus(objects[1], ranges, undefined) },
			{ object: objects[2], status: classifyObjectSyncStatus(objects[2], ranges, { name: 'SalesReport' }) },
			{ object: objects[3], status: classifyObjectSyncStatus(objects[3], [], undefined) }
		);
		const provider = new (require('../tree-data-providers').ExtensionUsageDataProvider)();
		provider.setObjects(objects, ranges);
		provider.setSyncStatuses(statuses);
		/** @type {{ url: string, options: RequestInit }[]} */
		const requests = [];
		try {
			global.fetch = async (url, options = {}) => {
				requests.push({ url: String(url), options });
				return options.method === 'PUT'
					? new Response('{}', { status: 201 })
					: new Response('[]', { status: 200 });
			};

			const results = await syncUnsyncedApplicationObjects(repositoryUrl, statuses, ranges, {}, provider);

			assert.deepStrictEqual(results, { synced: 1, failed: 0 });
			assert.strictEqual(requests.length, 2);
			assert.ok(requests[0].url.endsWith('/object-reservations/page?ref=main'));
			assert.ok(requests[1].url.endsWith('/object-reservations/page/page50002'));
			assert.deepStrictEqual(provider.objects.map(({ syncStatus }) => syncStatus), [
				'synced', 'synced', 'synced', 'outOfRange'
			]);
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

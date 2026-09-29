// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const EXTENSION_CONFIG = require('./config.json');

const GITHUB_AUTH_PROVIDER = EXTENSION_CONFIG.github.providerId;
const GITHUB_AUTH_SCOPES = EXTENSION_CONFIG.github.scopes;
const GITHUB_API_URL = EXTENSION_CONFIG.github.apiUrl;
const RANGE_REPOSITORY_NAME = EXTENSION_CONFIG.rangeRepository.name;
const RANGE_REPOSITORY_DISPLAY_NAME = EXTENSION_CONFIG.rangeRepository.displayName;
const RANGE_FILE_NAME = EXTENSION_CONFIG.rangeRepository.fileName;
const RANGE_BRANCH = EXTENSION_CONFIG.rangeRepository.branch;
const OBJECT_RESERVATION_DIRECTORY = EXTENSION_CONFIG.rangeRepository.objectReservationsDirectory;
const INITIAL_RANGE_DATA = EXTENSION_CONFIG.rangeRepository.initialData;
const REPOSITORY_OWNER_SETTING = EXTENSION_CONFIG.settings.repositoryOwner;
const REPOSITORY_ACCOUNT_SETTING = EXTENSION_CONFIG.settings.repositoryAccountId;
const APP_ID_PATTERN = new RegExp(EXTENSION_CONFIG.workspace.appIdPattern, 'i');
let disposeActiveFeatures = () => {};

/** @typedef {{ login: string }} GitHubUser */
/** @typedef {{ login: string }} GitHubOrganization */
/** @typedef {{ default_branch: string }} GitHubRepository */
/** @typedef {{ content: string, sha: string }} GitHubContentsFile */
/** @typedef {{ object: { sha: string } }} GitHubReference */
/** @typedef {{ id: string, name: string, publisher: string, ranges: Array<{ from: number, to: number }> }} RangeRegistration */
/** @typedef {{ Remarks: string[], ranges: RangeRegistration[] }} RangeData */
/** @typedef {{ 'object type': string, 'object name': string, 'object id': string }} ExtensionObject */
/** @typedef {'outOfRange' | 'conflict' | 'synced' | 'unsynced' | 'checking' | 'unavailable'} ObjectSyncStatus */
/** @typedef {ExtensionObject & { syncStatus: ObjectSyncStatus }} ExtensionUsageEntry */
/** @typedef {Record<string, string>} GitHubApiHeaders */
/** @typedef {{ label: string, description?: string, isSelected?: boolean, syncStatus?: ObjectSyncStatus, contextValue?: string, object?: ExtensionUsageEntry, command?: string, children?: DebugTreeItem[] }} DebugTreeItem */

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	/** @type {vscode.Disposable[]} */
	const featureDisposables = [];
	let featuresActive = false;
	let workspaceCheckId = 0;
	const updateWorkspaceState = async () => {
		const checkId = ++workspaceCheckId;
		const shouldActivate = await hasAlWorkspace();
		if (checkId !== workspaceCheckId || shouldActivate === featuresActive) {
			return;
		}
		if (shouldActivate) {
			featuresActive = true;
			startFeatures(featureDisposables);
		} else {
			featuresActive = false;
			for (const disposable of featureDisposables.splice(0)) {
				disposable.dispose();
			}
		}
	};
	const appManifestWatcher = vscode.workspace.createFileSystemWatcher(EXTENSION_CONFIG.workspace.appManifestPattern);
	const workspaceChangeListener = vscode.workspace.onDidChangeWorkspaceFolders(() => void updateWorkspaceState());
	const appManifestChangeListener = appManifestWatcher.onDidChange(() => void updateWorkspaceState());
	const appManifestCreateListener = appManifestWatcher.onDidCreate(() => void updateWorkspaceState());
	const appManifestDeleteListener = appManifestWatcher.onDidDelete(() => void updateWorkspaceState());
	context.subscriptions.push(
		appManifestWatcher,
		workspaceChangeListener,
		appManifestChangeListener,
		appManifestCreateListener,
		appManifestDeleteListener
	);
	disposeActiveFeatures = () => {
		for (const disposable of featureDisposables.splice(0)) {
			disposable.dispose();
		}
		featuresActive = false;
	};
	void updateWorkspaceState();
}

/** @param {vscode.Disposable[]} featureDisposables */
function startFeatures(featureDisposables) {
	console.log('Congratulations, your extension "object-manager" is now active!');
	const debugProvider = new GithubDebugDataProvider();
	const organizationUsageProvider = new OrganizationUsageDataProvider();
	const extensionUsageProvider = new ExtensionUsageDataProvider();
	const rangeDiagnostics = vscode.languages.createDiagnosticCollection('object-manager');
	let extensionObjectRefresh = Promise.resolve();
	const refreshExtensionObjects = () => {
		const nextRefresh = extensionObjectRefresh
			.then(async () => {
				const [objects, appManifest] = await Promise.all([
					collectExtensionObjects(),
					getAlApplicationManifest()
				]);
				extensionUsageProvider.setObjects(objects, appManifest?.manifest.idRanges);
			})
			.catch((error) => console.error('Unable to refresh AL objects:', error));
		extensionObjectRefresh = nextRefresh;
		return nextRefresh;
	};
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let alFileChangeTimer;
	const refreshForAlFileChange = () => {
		clearTimeout(alFileChangeTimer);
		alFileChangeTimer = setTimeout(() => {
			void refreshExtensionObjects().then(() => refreshRepositoryState());
		}, 250);
	};
	/** @param {vscode.Uri} uri */
	const isAlFileUri = (uri) => uri.path.toLowerCase().endsWith(EXTENSION_CONFIG.workspace.alSourceExtension);
	const alFileWatcher = vscode.workspace.createFileSystemWatcher(EXTENSION_CONFIG.workspace.alSourcePattern);
	const alFileChangeListener = alFileWatcher.onDidChange(refreshForAlFileChange);
	const alFileCreateListener = alFileWatcher.onDidCreate(refreshForAlFileChange);
	const alFileDeleteListener = alFileWatcher.onDidDelete(refreshForAlFileChange);
	const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
		if (document.uri.path.toLowerCase().endsWith(EXTENSION_CONFIG.workspace.alSourceExtension)) {
			refreshForAlFileChange();
		}
	});
	const createFilesListener = vscode.workspace.onDidCreateFiles((event) => {
		if (event.files.some(isAlFileUri)) {
			refreshForAlFileChange();
		}
	});
	const deleteFilesListener = vscode.workspace.onDidDeleteFiles((event) => {
		if (event.files.some(isAlFileUri)) {
			refreshForAlFileChange();
		}
	});
	const renameFilesListener = vscode.workspace.onDidRenameFiles((event) => {
		if (event.files.some(({ oldUri, newUri }) => isAlFileUri(oldUri) || isAlFileUri(newUri))) {
			refreshForAlFileChange();
		}
	});
	void refreshExtensionObjects();
	let repositoryRefresh = Promise.resolve();
	const refreshRepositoryState = (showAccountPicker = false, manualRangeUpdate = false) => {
		const nextRefresh = repositoryRefresh
			.then(async () => {
				await extensionObjectRefresh;
				return configureGithubRepositoryOwner(
					showAccountPicker,
					debugProvider,
					organizationUsageProvider,
					rangeDiagnostics,
					manualRangeUpdate,
					extensionUsageProvider
				);
			})
			.catch((error) => console.error('Unable to refresh GitHub repository state:', error));
		repositoryRefresh = nextRefresh;
		return nextRefresh;
	};
	void refreshRepositoryState();
	const authenticationChangeListener = vscode.authentication.onDidChangeSessions((event) => {
		if (event.provider.id === GITHUB_AUTH_PROVIDER) {
			void refreshRepositoryState();
		}
	});
	const configurationChangeListener = vscode.workspace.onDidChangeConfiguration((event) => {
		if (
			event.affectsConfiguration(`object-manager.${REPOSITORY_OWNER_SETTING}`) ||
			event.affectsConfiguration(`object-manager.${REPOSITORY_ACCOUNT_SETTING}`)
		) {
			void refreshRepositoryState();
		}
	});
	const repositoryCheckTimer = setInterval(
		() => void refreshRepositoryState(),
		getRepositoryCheckIntervalMs()
	);

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with  registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('object-manager.helloWorld', function () {
		// The code you place here will be executed every time your command is executed

		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from object-manager!');
	});
	const manageAccountPreference = vscode.commands.registerCommand(
		'object-manager.manageAccountPreference',
		() => refreshRepositoryState(true)
	);
	const createUpdateApplicationRange = vscode.commands.registerCommand(
		'object-manager.createUpdateApplicationRange',
		() => refreshRepositoryState(false, true)
	);
	const syncObjectReservation = vscode.commands.registerCommand(
		'object-manager.syncObjectReservation',
		async (treeItem) => {
			const selectedObject = treeItem?.object;
			if (!selectedObject) {
				return;
			}
			const object = extensionUsageProvider.getCurrentObject(selectedObject);
			if (!object || object.syncStatus !== 'unsynced' || extensionUsageProvider.isObjectSyncing(object)) {
				return;
			}
			extensionUsageProvider.setObjectSyncing(object, true);
			try {
				const appManifest = await getAlApplicationManifest();
				if (!appManifest || !Array.isArray(appManifest.manifest.idRanges)) {
					vscode.window.showErrorMessage(`Unable to sync this object because ${EXTENSION_CONFIG.workspace.appManifestFileName} has no valid idRanges.`);
					return;
				}
				if (!isObjectIdInRanges(object['object id'], appManifest.manifest.idRanges)) {
					extensionUsageProvider.setObjectSyncStatus(object, 'outOfRange');
					return;
				}
				const session = await selectGithubAccount();
				if (!session) {
					throw new Error('Sign in to GitHub before syncing object reservations.');
				}
				const configuration = vscode.workspace.getConfiguration('object-manager');
				const owner = configuration.get(REPOSITORY_OWNER_SETTING);
				const accountId = configuration.get(REPOSITORY_ACCOUNT_SETTING);
				if (typeof owner !== 'string' || !owner || accountId !== session.account.id) {
					vscode.window.showInformationMessage('Choose the repository owner before syncing this object.');
					await refreshRepositoryState(true);
					return;
				}
				const repositoryUrl = `${GITHUB_API_URL}/repos/${encodeURIComponent(owner)}/${RANGE_REPOSITORY_NAME}`;
				const status = await checkAndUploadApplicationObject(
					repositoryUrl,
					object,
					appManifest.manifest.idRanges,
					getGithubHeaders(session)
				);
				extensionUsageProvider.setObjectSyncStatus(object, status);
				if (status === 'conflict') {
					vscode.window.showErrorMessage('A different reservation already exists. Nothing was overwritten.');
				} else if (status === 'synced') {
					vscode.window.showInformationMessage('Object reservation is synced.');
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				extensionUsageProvider.setObjectSyncStatus(object, 'unavailable');
				vscode.window.showErrorMessage(`Unable to sync object reservation: ${message}`);
			} finally {
				extensionUsageProvider.setObjectSyncing(object, false);
			}
		}
	);
	const syncObjectReservationBusy = vscode.commands.registerCommand(
		'object-manager.syncObjectReservationBusy',
		() => undefined
	);

	featureDisposables.push(
		disposable,
		manageAccountPreference,
		createUpdateApplicationRange,
		syncObjectReservation,
		syncObjectReservationBusy,
		rangeDiagnostics,
		alFileWatcher,
		alFileChangeListener,
		alFileCreateListener,
		alFileDeleteListener,
		saveListener,
		createFilesListener,
		deleteFilesListener,
		renameFilesListener,
		{ dispose: () => clearTimeout(alFileChangeTimer) },
		authenticationChangeListener,
		configurationChangeListener,
		{ dispose: () => clearInterval(repositoryCheckTimer) },
		vscode.window.registerTreeDataProvider('object-manager.commands', new TreeDataProvider([
			{ label: 'Hello World', command: 'object-manager.helloWorld' }
		])),
		vscode.window.registerTreeDataProvider('object-manager.extensionUsage', extensionUsageProvider),
		vscode.window.registerTreeDataProvider('object-manager.organizationUsage', organizationUsageProvider),
		vscode.window.registerTreeDataProvider('object-manager.debug', debugProvider)
	);
}

/** @param {string} source @returns {ExtensionObject[]} */
function parseAlObjects(source) {
	const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
		comment.replace(/[^\r\n]/g, ' ')
	);
	const objectTypes = /** @type {Record<string, string>} */ ({
		table: 'Table',
		report: 'Report',
		codeunit: 'Codeunit',
		xmlport: 'XMLport',
		menusuite: 'MenuSuite',
		page: 'Page',
		query: 'Query'
	});
	const objectPattern = /^\s*(table|report|codeunit|xmlport|menusuite|page|query)\s+(\d+)\s+("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*)/gim;
	/** @type {ExtensionObject[]} */
	const objects = [];
	for (const match of withoutBlockComments.matchAll(objectPattern)) {
		const rawName = match[3];
		objects.push({
			'object type': objectTypes[match[1].toLowerCase()],
			'object name': rawName.startsWith('"')
				? rawName.slice(1, -1).replace(/""/g, '"')
				: rawName,
			'object id': match[2]
		});
	}
	return objects;
}

/** @returns {Promise<ExtensionObject[]>} */
async function collectExtensionObjects() {
	const files = (await vscode.workspace.findFiles(EXTENSION_CONFIG.workspace.alSourcePattern)).sort((left, right) =>
		left.toString().localeCompare(right.toString())
	);
	/** @type {Map<string, ExtensionObject>} */
	const objectsById = new Map();
	for (const file of files) {
		try {
			const content = await vscode.workspace.fs.readFile(file);
			for (const object of parseAlObjects(Buffer.from(content).toString('utf8'))) {
				objectsById.set(`${object['object type']}:${object['object id']}`, object);
			}
		} catch (error) {
			console.warn(`Unable to read AL source file ${file.toString()}:`, error);
		}
	}
	return [...objectsById.values()].sort((left, right) =>
		left['object type'].localeCompare(right['object type']) ||
		Number(left['object id']) - Number(right['object id'])
	);
}

/** @param {string} objectId @param {unknown} ranges */
function isObjectIdInRanges(objectId, ranges) {
	const numericId = Number(objectId);
	return Number.isFinite(numericId) && Array.isArray(ranges) && ranges.some((range) =>
		range && typeof range === 'object' &&
		typeof range.from === 'number' && typeof range.to === 'number' &&
		numericId >= range.from && numericId <= range.to
	);
}

/** @param {ExtensionObject} object */
function getExtensionObjectKey(object) {
	return `${object['object type']}:${object['object id']}`;
}

/** @param {string} filename */
function normalizeObjectFilename(filename) {
	return filename
		.replace(/\.json$/i, '')
		.replace(/[^a-z0-9]/gi, '')
		.toLowerCase();
}

/** @param {ExtensionObject} object @param {unknown} ranges @param {unknown} remoteRecord @returns {ObjectSyncStatus} */
function classifyObjectSyncStatus(object, ranges, remoteRecord) {
	if (!isObjectIdInRanges(object['object id'], ranges)) {
		return 'outOfRange';
	}
	if (remoteRecord === undefined) {
		return 'unsynced';
	}
	const record = /** @type {{ name?: unknown }} */ (remoteRecord);
	if (!record || typeof record !== 'object' || typeof record.name !== 'string') {
		return 'conflict';
	}
	return record.name === object['object name']
		? 'synced'
		: 'conflict';
}

/**
 * @param {string} repositoryUrl
 * @param {ExtensionObject[]} objects
 * @param {unknown} ranges
 * @param {GitHubApiHeaders} headers
 * @returns {Promise<Array<{ object: ExtensionObject, status: ObjectSyncStatus }>>}
 */
async function getApplicationObjectStatuses(repositoryUrl, objects, ranges, headers) {
	/** @type {Map<string, Promise<unknown[]>>} */
	const folderContentsByType = new Map();
	return Promise.all(objects.map(async (object) => {
		if (!isObjectIdInRanges(object['object id'], ranges)) {
			return { object, status: 'outOfRange' };
		}
		const objectType = object['object type'].toLowerCase();
		let folderContentsPromise = folderContentsByType.get(objectType);
		if (!folderContentsPromise) {
			folderContentsPromise = getObjectTypeFolderContents(repositoryUrl, objectType, headers);
			folderContentsByType.set(objectType, folderContentsPromise);
		}
		const folderContents = await folderContentsPromise;
		return {
			object,
			status: await getReservationFileStatus(folderContents, object, ranges, headers) || 'unsynced'
		};
	}));
}

/** @param {string} repositoryUrl @param {string} objectType @param {GitHubApiHeaders} headers */
async function getObjectTypeFolderContents(repositoryUrl, objectType, headers) {
	const folderPath = `${OBJECT_RESERVATION_DIRECTORY}/${encodeURIComponent(objectType)}`;
	const folderUrl = `${repositoryUrl}/contents/${folderPath}?ref=${encodeURIComponent(RANGE_BRANCH)}`;
	const response = await fetch(folderUrl, { headers });
	if (response.status === 404) {
		return [];
	}
	if (!response.ok) {
		throw new Error(await getGithubResponseError(response));
	}
	const folderContents = await response.json();
	if (!Array.isArray(folderContents)) {
		throw new Error(`GitHub returned an invalid ${folderPath} directory listing.`);
	}
	return folderContents;
}

/**
 * @param {unknown[]} folderContents
 * @param {ExtensionObject} object
 * @param {unknown} ranges
 * @param {GitHubApiHeaders} headers
 * @returns {Promise<ObjectSyncStatus | undefined>}
 */
async function getReservationFileStatus(folderContents, object, ranges, headers) {
	const expectedName = normalizeObjectFilename(`${object['object type']}${object['object id']}`);
	const matchingFiles = folderContents.filter((entry) => {
		const file = /** @type {{ type?: unknown, name?: unknown }} */ (entry);
		return file && file.type === 'file' && typeof file.name === 'string' &&
			normalizeObjectFilename(file.name) === expectedName;
	});
	if (matchingFiles.length === 0) {
		return undefined;
	}
	if (matchingFiles.length > 1) {
		return 'conflict';
	}
	const fileEntry = /** @type {{ url?: unknown }} */ (matchingFiles[0]);
	if (typeof fileEntry.url !== 'string') {
		return 'conflict';
	}
	const file = /** @type {GitHubContentsFile} */ (await getGithubJson(fileEntry.url, headers));
	let remoteRecord;
	try {
		const content = Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8');
		remoteRecord = JSON.parse(content);
	} catch {
		remoteRecord = null;
	}
	return classifyObjectSyncStatus(object, ranges, remoteRecord);
}

/**
 * @param {string} repositoryUrl
 * @param {ExtensionObject} object
 * @param {unknown} ranges
 * @param {GitHubApiHeaders} headers
 * @returns {Promise<ObjectSyncStatus>}
 */
async function checkAndUploadApplicationObject(repositoryUrl, object, ranges, headers) {
	if (!isObjectIdInRanges(object['object id'], ranges)) {
		return 'outOfRange';
	}
	const objectType = object['object type'].toLowerCase();
	const folderPath = `${OBJECT_RESERVATION_DIRECTORY}/${encodeURIComponent(objectType)}`;
	const folderUrl = `${repositoryUrl}/contents/${folderPath}?ref=${encodeURIComponent(RANGE_BRANCH)}`;
	const folderContents = await getObjectTypeFolderContents(repositoryUrl, objectType, headers);
	const existingStatus = await getReservationFileStatus(folderContents, object, ranges, headers);
	if (existingStatus) {
		return existingStatus;
	}
	const filePath = `${folderPath}/${encodeURIComponent(`${objectType}${object['object id']}`)}`;
	const fileUrl = `${repositoryUrl}/contents/${filePath}`;
	const reservation = {
		name: object['object name'],
		timestamp: new Date().toISOString(),
		repo: repositoryUrl
	};
	const response = await fetch(fileUrl, {
		method: 'PUT',
		headers,
		body: JSON.stringify({
			message: `Add reservation for ${object['object type']} ${object['object id']}`,
			content: Buffer.from(JSON.stringify(reservation, null, 4)).toString('base64'),
			branch: RANGE_BRANCH
		})
	});
	if (response.status === 409 || response.status === 422) {
		const latestContents = await getGithubJson(folderUrl, headers);
		if (!Array.isArray(latestContents)) {
			throw new Error(`GitHub returned an invalid ${folderPath} directory listing.`);
		}
		return await getReservationFileStatus(latestContents, object, ranges, headers) || 'conflict';
	}
	if (!response.ok) {
		throw new Error(await getGithubResponseError(response));
	}
	return 'synced';
}

/** @param {unknown} manifest */
function isValidAlManifest(manifest) {
	return Boolean(
		manifest && typeof manifest === 'object' && 'id' in manifest &&
		typeof manifest.id === 'string' && APP_ID_PATTERN.test(manifest.id)
	);
}

/** @param {ReadonlyArray<vscode.WorkspaceFolder>} [workspaceFolders] */
async function hasAlWorkspace(workspaceFolders = vscode.workspace.workspaceFolders || []) {
	for (const folder of workspaceFolders) {
		try {
			const appJsonUri = vscode.Uri.joinPath(folder.uri, EXTENSION_CONFIG.workspace.appManifestFileName);
			const appJson = await vscode.workspace.fs.readFile(appJsonUri);
			if (isValidAlManifest(JSON.parse(Buffer.from(appJson).toString('utf8')))) {
				return true;
			}
		} catch {}
	}
	return false;
}

function getRepositoryCheckIntervalMs() {
	const intervalMinutes = vscode.workspace
		.getConfiguration('object-manager')
		.get('repositoryCheckIntervalMinutes', 5);
	return Math.max(1, Number(intervalMinutes)) * 60 * 1000;
}

function selectGithubAccount(showAccountPicker = false) {
	return vscode.authentication.getSession(
		GITHUB_AUTH_PROVIDER,
		GITHUB_AUTH_SCOPES,
		{
			createIfNone: true,
			clearSessionPreference: showAccountPicker
		}
	);
}

/** @param {vscode.AuthenticationSession} session */
function getGithubHeaders(session) {
	return {
		Accept: EXTENSION_CONFIG.github.acceptHeader,
		Authorization: `Bearer ${session.accessToken}`,
		'X-GitHub-Api-Version': EXTENSION_CONFIG.github.apiVersion
	};
}

/**
 * @param {GithubDebugDataProvider} [debugProvider]
 * @param {OrganizationUsageDataProvider} [organizationUsageProvider]
 * @param {vscode.DiagnosticCollection} [rangeDiagnostics]
 * @param {boolean} [manualRangeUpdate]
 * @param {ExtensionUsageDataProvider} [extensionUsageProvider]
 */
async function configureGithubRepositoryOwner(
	showAccountPicker = false,
	debugProvider,
	organizationUsageProvider,
	rangeDiagnostics,
	manualRangeUpdate = false,
	extensionUsageProvider
) {
	if (!await hasAlWorkspace()) {
		if (showAccountPicker) {
			vscode.window.showInformationMessage('Open a valid AL workspace before configuring a GitHub account.');
		}
		debugProvider?.refresh();
		organizationUsageProvider?.setStatus('Open a valid AL workspace to load organization usage.');
		return;
	}
	organizationUsageProvider?.setStatus(`Checking ${RANGE_REPOSITORY_NAME}/${RANGE_FILE_NAME}...`);
	debugProvider?.setRemarks([]);

	try {
		const session = await selectGithubAccount(showAccountPicker);
		if (!session) {
			organizationUsageProvider?.setStatus(`Select a GitHub account to load ${RANGE_FILE_NAME}.`);
			extensionUsageProvider?.setSyncUnavailable('Sign in to GitHub to check object reservations.');
			return;
		}

		const headers = getGithubHeaders(session);
		const user = /** @type {GitHubUser} */ (
			await getGithubJson(`${GITHUB_API_URL}/user`, headers)
		);
		const organizations = await getGithubOrganizations(headers);
		const accountLogin = user.login;
		const validOwners = [accountLogin, ...organizations.map((organization) => organization.login)];
		const configuration = vscode.workspace.getConfiguration('object-manager');
		const configuredOwner = configuration.get(REPOSITORY_OWNER_SETTING);
		const configuredAccountId = configuration.get(REPOSITORY_ACCOUNT_SETTING);
		const accountChanged = configuredAccountId !== session.account.id;

		if (organizations.length === 0) {
			await saveRepositoryOwner(accountLogin, session.account.id);
			await ensureRangeRepository(
				accountLogin, accountLogin, headers, organizationUsageProvider, debugProvider,
				rangeDiagnostics, manualRangeUpdate, extensionUsageProvider
			);
			return;
		}

		if (!showAccountPicker && !accountChanged && typeof configuredOwner === 'string' && validOwners.includes(configuredOwner)) {
			await ensureRangeRepository(
				configuredOwner, accountLogin, headers, organizationUsageProvider, debugProvider,
				rangeDiagnostics, manualRangeUpdate, extensionUsageProvider
			);
			return;
		}

		const choices = [
			{
				label: `${accountLogin} (Personal account)`,
				description: `Create ${RANGE_REPOSITORY_DISPLAY_NAME} under your account`,
				owner: accountLogin
			},
			...organizations.map((organization) => ({
				label: `${organization.login} (Organization)`,
				description: `Create ${RANGE_REPOSITORY_DISPLAY_NAME} under this organization`,
				owner: organization.login
			}))
		];
		const selection = await vscode.window.showQuickPick(choices, {
			placeHolder: `Where should ${RANGE_REPOSITORY_DISPLAY_NAME} be created?`
		});

		if (selection) {
			await saveRepositoryOwner(selection.owner, session.account.id);
			await ensureRangeRepository(
				selection.owner, accountLogin, headers, organizationUsageProvider, debugProvider,
				rangeDiagnostics, manualRangeUpdate, extensionUsageProvider
			);
		} else {
			organizationUsageProvider?.setStatus(`Select an account or organization to load ${RANGE_FILE_NAME}.`);
			extensionUsageProvider?.setSyncUnavailable('Select a GitHub repository owner to check object reservations.');
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		organizationUsageProvider?.setStatus(`Unable to load ${RANGE_FILE_NAME}: ${message}`);
		extensionUsageProvider?.setSyncUnavailable(message);
		vscode.window.showErrorMessage(`Unable to configure the GitHub repository owner: ${message}`);
	} finally {
		debugProvider?.refresh();
	}
}

/** @param {GitHubApiHeaders} headers */
async function getGithubOrganizations(headers) {
	const organizations = [];
	for (let page = 1; ; page++) {
		const pageOrganizations = /** @type {GitHubOrganization[]} */ (await getGithubJson(
			`${GITHUB_API_URL}/user/orgs?per_page=${EXTENSION_CONFIG.github.organizationPageSize}&page=${page}`,
			headers
		));
		organizations.push(...pageOrganizations);
		if (pageOrganizations.length < EXTENSION_CONFIG.github.organizationPageSize) {
			return organizations;
		}
	}
}

/**
 * @param {string} owner
 * @param {string} accountLogin
 * @param {GitHubApiHeaders} headers
 * @param {OrganizationUsageDataProvider} [organizationUsageProvider]
 * @param {GithubDebugDataProvider} [debugProvider]
 * @param {vscode.DiagnosticCollection} [rangeDiagnostics]
 * @param {boolean} [manualRangeUpdate]
 * @param {ExtensionUsageDataProvider} [extensionUsageProvider]
 */
async function ensureRangeRepository(
	owner,
	accountLogin,
	headers,
	organizationUsageProvider,
	debugProvider,
	rangeDiagnostics,
	manualRangeUpdate = false,
	extensionUsageProvider
) {
	const repositoryPath = `/repos/${encodeURIComponent(owner)}/${RANGE_REPOSITORY_NAME}`;
	const repositoryUrl = `${GITHUB_API_URL}${repositoryPath}`;
	const repositoryResponse = await fetch(repositoryUrl, { headers });
	let rangeData;

	if (repositoryResponse.status === 404) {
		const createUrl = owner === accountLogin
			? `${GITHUB_API_URL}/user/repos`
			: `${GITHUB_API_URL}/orgs/${encodeURIComponent(owner)}/repos`;
		let repository = /** @type {GitHubRepository} */ (await getGithubJson(
			createUrl,
			headers,
			{
				method: 'POST',
				body: JSON.stringify({
						name: RANGE_REPOSITORY_NAME,
					private: true,
					auto_init: true
				})
			}
		));
		await ensureMainBranch(owner, repository, headers);
		await createRangeFile(repositoryUrl, headers);
		rangeData = INITIAL_RANGE_DATA;
	} else {
		if (!repositoryResponse.ok) {
			throw new Error(await getGithubResponseError(repositoryResponse));
		}

		const contentsUrl = `${repositoryUrl}/contents/${encodeURIComponent(RANGE_FILE_NAME)}?ref=${encodeURIComponent(RANGE_BRANCH)}`;
		const contentsResponse = await fetch(contentsUrl, { headers });
		if (contentsResponse.status === 404) {
			await createRangeFile(repositoryUrl, headers);
			rangeData = INITIAL_RANGE_DATA;
		} else {
			if (!contentsResponse.ok) {
				throw new Error(await getGithubResponseError(contentsResponse));
			}
			const file = /** @type {GitHubContentsFile} */ (await contentsResponse.json());
			rangeData = parseRangeData(file);
		}
	}

	const appManifest = await getAlApplicationManifest();
	if (appManifest) {
		const registration = createApplicationRegistration(appManifest.manifest);
		const existingRegistration = rangeData.ranges.find((item) => item.id === registration.id);
		if (existingRegistration) {
			rangeDiagnostics?.delete(appManifest.uri);
		} else {
			setMissingRangeDiagnostic(rangeDiagnostics, appManifest.uri);
			const contentsUrl = `${repositoryUrl}/contents/${encodeURIComponent(RANGE_FILE_NAME)}`;
			const latestResponse = await fetch(`${contentsUrl}?ref=${encodeURIComponent(RANGE_BRANCH)}`, { headers });
			if (!latestResponse.ok) {
				throw new Error(await getGithubResponseError(latestResponse));
			}
			const latestFile = /** @type {GitHubContentsFile} */ (await latestResponse.json());
			const latestData = parseRangeData(latestFile);
			if (latestData.ranges.some((item) => item.id === registration.id)) {
				rangeData = latestData;
				rangeDiagnostics?.delete(appManifest.uri);
			} else {
				const updatedData = { ...latestData, ranges: [...latestData.ranges, registration] };
				const updateResponse = await fetch(contentsUrl, {
					method: 'PUT',
					headers,
					body: JSON.stringify({
						message: `${manualRangeUpdate ? 'Manually add' : 'Add'} ${registration.name} application range`,
						content: Buffer.from(JSON.stringify(updatedData, null, 4)).toString('base64'),
						sha: latestFile.sha,
						branch: RANGE_BRANCH
					})
				});
				if (updateResponse.status === 409 || updateResponse.status === 422) {
					const refreshedResponse = await fetch(`${contentsUrl}?ref=${encodeURIComponent(RANGE_BRANCH)}`, { headers });
					let refreshError;
					if (refreshedResponse.ok) {
						rangeData = parseRangeData(/** @type {GitHubContentsFile} */ (await refreshedResponse.json()));
					} else {
						refreshError = await getGithubResponseError(refreshedResponse);
					}
					if (rangeData.ranges.some((item) => item.id === registration.id)) {
						rangeDiagnostics?.delete(appManifest.uri);
					} else {
						setMissingRangeDiagnostic(rangeDiagnostics, appManifest.uri);
					}
					const action = 'Create/Update Application Range';
					const selection = await vscode.window.showErrorMessage(
						refreshError
							? `The range data changed while saving. Unable to reload ${RANGE_FILE_NAME}: ${refreshError}. Run ${action} to try again.`
							: `The range data changed while saving. ${RANGE_FILE_NAME} was downloaded again. Run ${action} to try again.`,
						action
					);
					if (selection === action) {
						void vscode.commands.executeCommand('object-manager.createUpdateApplicationRange');
					}
				} else if (!updateResponse.ok) {
					throw new Error(await getGithubResponseError(updateResponse));
				} else {
					rangeData = updatedData;
					rangeDiagnostics?.delete(appManifest.uri);
				}
			}
		}
		const localObjects = extensionUsageProvider?.getObjects() || await collectExtensionObjects();
		const syncStatuses = await getApplicationObjectStatuses(
			repositoryUrl,
			localObjects,
			registration.ranges,
			headers
		);
		extensionUsageProvider?.setSyncStatuses(syncStatuses);
	}

	organizationUsageProvider?.setRangeData(owner, rangeData);
	debugProvider?.setRemarks(rangeData.Remarks);
}

/** @param {GitHubContentsFile} file @returns {RangeData} */
function parseRangeData(file) {
	const fileContent = Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8');
	const parsedRangeData = /** @type {RangeData} */ (JSON.parse(fileContent));
	if (
		!parsedRangeData ||
		!Array.isArray(parsedRangeData.Remarks) ||
		!Array.isArray(parsedRangeData.ranges)
	) {
		throw new Error(`${RANGE_FILE_NAME} must contain Remarks and ranges arrays.`);
	}
	return parsedRangeData;
}

/** @param {Record<string, any>} manifest @returns {RangeRegistration} */
function createApplicationRegistration(manifest) {
	return {
		id: manifest.id,
		name: typeof manifest.name === 'string' ? manifest.name : '',
		publisher: typeof manifest.publisher === 'string' ? manifest.publisher : '',
		ranges: Array.isArray(manifest.idRanges) ? manifest.idRanges : []
	};
}

/** @returns {Promise<{ uri: vscode.Uri, manifest: Record<string, any> } | undefined>} */
async function getAlApplicationManifest() {
	for (const folder of vscode.workspace.workspaceFolders || []) {
		try {
			const uri = vscode.Uri.joinPath(folder.uri, EXTENSION_CONFIG.workspace.appManifestFileName);
			const content = await vscode.workspace.fs.readFile(uri);
			const manifest = JSON.parse(Buffer.from(content).toString('utf8'));
			if (isValidAlManifest(manifest)) {
				return { uri, manifest };
			}
		} catch {}
	}
	return undefined;
}

/** @param {vscode.DiagnosticCollection | undefined} diagnostics @param {vscode.Uri} uri */
function setMissingRangeDiagnostic(diagnostics, uri) {
	if (!diagnostics) {
		return;
	}
	const diagnostic = new vscode.Diagnostic(
		new vscode.Range(0, 0, 0, 0),
		`Application range is missing from ${RANGE_FILE_NAME}. Run "Create/Update Application Range" to add it.`,
		vscode.DiagnosticSeverity.Error
	);
	diagnostic.source = 'BC Object Manager';
	diagnostics.set(uri, [diagnostic]);
}

/**
 * @param {string} owner
 * @param {GitHubRepository} repository
 * @param {GitHubApiHeaders} headers
 * @returns {Promise<GitHubRepository>}
 */
async function ensureMainBranch(owner, repository, headers) {
	if (repository.default_branch === RANGE_BRANCH) {
		return repository;
	}

	const repositoryPath = `/repos/${encodeURIComponent(owner)}/${RANGE_REPOSITORY_NAME}`;
	const sourceReference = /** @type {GitHubReference} */ (await getGithubJson(
		`${GITHUB_API_URL}${repositoryPath}/git/ref/heads/${encodeURIComponent(repository.default_branch)}`,
		headers
	));
	await getGithubJson(`${GITHUB_API_URL}${repositoryPath}/git/refs`, headers, {
		method: 'POST',
		body: JSON.stringify({ ref: `refs/heads/${RANGE_BRANCH}`, sha: sourceReference.object.sha })
	});
	return /** @type {GitHubRepository} */ (await getGithubJson(
		`${GITHUB_API_URL}${repositoryPath}`,
		headers,
		{ method: 'PATCH', body: JSON.stringify({ default_branch: RANGE_BRANCH }) }
	));
}

/** @param {string} repositoryUrl @param {GitHubApiHeaders} headers */
async function createRangeFile(repositoryUrl, headers) {
	await getGithubJson(`${repositoryUrl}/contents/${encodeURIComponent(RANGE_FILE_NAME)}`, headers, {
		method: 'PUT',
		body: JSON.stringify({
			message: `Add initial ${RANGE_FILE_NAME}`,
			content: Buffer.from(JSON.stringify(INITIAL_RANGE_DATA, null, 4)).toString('base64'),
			branch: RANGE_BRANCH
		})
	});
}

/** @param {Response} response */
async function getGithubResponseError(response) {
	try {
		const body = /** @type {{ message?: unknown }} */ (await response.json());
		if (body && typeof body.message === 'string') {
			return `GitHub API returned ${response.status}: ${body.message}`;
		}
	} catch {}
	return `GitHub API returned ${response.status} ${response.statusText}.`;
}

/**
 * @param {string} url
 * @param {GitHubApiHeaders} headers
 * @param {RequestInit} [requestOptions]
 */
async function getGithubJson(url, headers, requestOptions = {}) {
	const response = await fetch(url, { ...requestOptions, headers });
	if (!response.ok) {
		throw new Error(await getGithubResponseError(response));
	}
	return response.json();
}

/**
 * @param {string} owner
 * @param {string} accountId
 */
function saveRepositoryOwner(owner, accountId) {
	const configuration = vscode.workspace.getConfiguration('object-manager');
	return Promise.all([
		configuration.update(REPOSITORY_OWNER_SETTING, owner, vscode.ConfigurationTarget.Workspace),
		configuration.update(REPOSITORY_ACCOUNT_SETTING, accountId, vscode.ConfigurationTarget.Workspace)
	]);
}

class TreeDataProvider {
	/** @param {DebugTreeItem[]} [items] */
	constructor(items = []) {
		this.changeEmitter = new vscode.EventEmitter();
		this.onDidChangeTreeData = this.changeEmitter.event;
		this.items = items;
	}

	refresh() {
		this.changeEmitter.fire(undefined);
	}

	/**
	 * @param {DebugTreeItem} item
	 * @returns {vscode.TreeItem}
	 */
	getTreeItem(item) {
		const treeItem = new vscode.TreeItem(
			item.label,
			item.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
		);
		treeItem.description = item.description;
		if (item.isSelected) {
			treeItem.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
		}
		if (item.syncStatus) {
			const icons = {
				outOfRange: ['close', 'testing.iconFailed'],
				conflict: ['warning', 'editorWarning.foreground'],
				synced: ['check', 'testing.iconPassed'],
				unsynced: ['cloud-upload', 'charts.blue'],
				checking: ['sync', 'charts.blue'],
				unavailable: ['circle-slash', 'editorWarning.foreground']
			};
			const [icon, color] = icons[item.syncStatus];
			treeItem.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
		}
		if (item.command) {
			treeItem.command = { command: item.command, title: item.label };
		}
		treeItem.contextValue = item.contextValue;
		return treeItem;
	}

	/**
	 * @param {DebugTreeItem} [element]
	 * @returns {Promise<DebugTreeItem[]>}
	 */
	async getChildren(element) {
		return element ? element.children || [] : this.items;
	}
}

class ExtensionUsageDataProvider extends TreeDataProvider {
	constructor() {
		super([{ label: 'Scanning AL source files...' }]);
		/** @type {ExtensionUsageEntry[]} */
		this.objects = [];
		/** @type {unknown} */
		this.ranges = undefined;
		/** @type {Map<string, { status: ObjectSyncStatus, name: string }>} */
		this.remoteStatuses = new Map();
		/** @type {Set<string>} */
		this.syncingObjects = new Set();
		/** @type {string | undefined} */
		this.syncError = undefined;
	}

	/** @param {ExtensionObject[]} objects @param {unknown} ranges */
	setObjects(objects, ranges) {
		this.ranges = ranges;
		this.syncError = undefined;
		this.objects = objects.map((object) => {
			const key = getExtensionObjectKey(object);
			const remoteStatus = this.remoteStatuses.get(key);
			const status = !isObjectIdInRanges(object['object id'], ranges)
				? 'outOfRange'
				: remoteStatus?.name === object['object name']
					? remoteStatus.status
					: 'checking';
			return { ...object, syncStatus: status };
		});
		this.renderObjects();
	}

	/** @returns {ExtensionObject[]} */
	getObjects() {
		return this.objects.map((object) => ({
			'object type': object['object type'],
			'object name': object['object name'],
			'object id': object['object id']
		}));
	}

	/** @param {ExtensionObject} object @returns {ExtensionUsageEntry | undefined} */
	getCurrentObject(object) {
		return this.objects.find((entry) =>
			getExtensionObjectKey(entry) === getExtensionObjectKey(object) &&
			entry['object name'] === object['object name']
		);
	}

	/** @param {ExtensionObject} object @param {ObjectSyncStatus} status */
	setObjectSyncStatus(object, status) {
		const key = getExtensionObjectKey(object);
		this.remoteStatuses.set(key, { status, name: object['object name'] });
		this.objects = this.objects.map((entry) =>
			getExtensionObjectKey(entry) === key && entry['object name'] === object['object name']
				? { ...entry, syncStatus: status }
				: entry
		);
		this.renderObjects();
	}

	/** @param {ExtensionObject} object @param {boolean} syncing */
	setObjectSyncing(object, syncing) {
		const key = getExtensionObjectKey(object);
		if (syncing) {
			this.syncingObjects.add(key);
		} else {
			this.syncingObjects.delete(key);
		}
		this.renderObjects();
	}

	/** @param {ExtensionObject} object @returns {boolean} */
	isObjectSyncing(object) {
		return this.syncingObjects.has(getExtensionObjectKey(object));
	}

	/** @param {Array<{ object: ExtensionObject, status: ObjectSyncStatus }>} statuses */
	setSyncStatuses(statuses) {
		this.syncError = undefined;
		this.remoteStatuses = new Map(statuses.map(({ object, status }) => [
			getExtensionObjectKey(object),
			{ status, name: object['object name'] }
		]));
		this.objects = this.objects.map((entry) => ({
			...entry,
			syncStatus: !isObjectIdInRanges(entry['object id'], this.ranges)
				? 'outOfRange'
				: this.remoteStatuses.get(getExtensionObjectKey(entry))?.status || 'checking'
		}));
		this.renderObjects();
	}

	/** @param {string} message */
	setSyncUnavailable(message) {
		this.syncError = message;
		this.objects = this.objects.map((entry) => ({
			...entry,
			syncStatus: isObjectIdInRanges(entry['object id'], this.ranges) ? 'unavailable' : 'outOfRange'
		}));
		this.renderObjects();
	}

	renderObjects() {
		const groups = /** @type {{ status: ObjectSyncStatus, label: string }[]} */ ([
			{ status: 'conflict', label: 'Conflicts' },
			{ status: 'unsynced', label: 'Unsynced' },
			{ status: 'outOfRange', label: 'Out of range' },
			{ status: 'synced', label: 'Synced' },
			{ status: 'checking', label: 'Checking' },
			{ status: 'unavailable', label: 'Sync unavailable' }
		]);
		this.items = this.objects.length === 0
			? [{ label: 'No AL objects found.' }]
			: groups.flatMap(({ status, label }) => {
				const matches = this.objects.filter((object) => object.syncStatus === status);
				return matches.length === 0 ? [] : [{
					label: `${label} (${matches.length})`,
					description: status === 'unavailable' ? this.syncError : undefined,
					syncStatus: status,
					children: matches.map((object) => ({
						label: `${object['object type']} ${object['object name']}`,
						description: object['object id'],
						syncStatus: object.syncStatus,
							contextValue: object.syncStatus === 'unsynced'
								? this.isObjectSyncing(object) ? 'syncingObject' : 'unsyncedObject'
								: undefined,
						object
					}))
				}];
			});
		this.refresh();
	}
}

class OrganizationUsageDataProvider extends TreeDataProvider {
	constructor() {
		super([{ label: 'Waiting for GitHub account selection.' }]);
	}

	/** @param {string} message */
	setStatus(message) {
		this.items = [{ label: message }];
		this.refresh();
	}

	/**
	 * @param {string} owner
	 * @param {RangeData} rangeData
	 */
	setRangeData(owner, rangeData) {
		this.items = [{
			label: RANGE_FILE_NAME,
			description: `${owner}/${RANGE_REPOSITORY_NAME} (${RANGE_BRANCH})`,
			children: rangeData.ranges.map((registration) => ({
				label: `${registration.name} (${registration.publisher})`,
				description: registration.id,
				children: registration.ranges.map((range) => ({
					label: `${range.from}-${range.to}`
				}))
			}))
		}];
		this.refresh();
	}

	/**
	 * @param {DebugTreeItem} [element]
	 * @returns {Promise<DebugTreeItem[]>}
	 */
	async getChildren(element) {
		if (!element && !await hasAlWorkspace()) {
			return [{ label: 'Open a valid AL workspace to load organization usage.' }];
		}
		return super.getChildren(element);
	}
}

class GithubDebugDataProvider extends TreeDataProvider {
	constructor() {
		super();
		/** @type {string[]} */
		this.remarks = [];
	}

	/** @param {string[]} remarks */
	setRemarks(remarks) {
		this.remarks = remarks;
		this.refresh();
	}

	/**
	 * @param {DebugTreeItem} [element]
	 * @returns {Promise<DebugTreeItem[]>}
	 */
	async getChildren(element) {
		if (element) {
			return element.children || [];
		}
		if (!await hasAlWorkspace()) {
			return [{ label: 'Open a valid AL workspace to inspect GitHub accounts.' }];
		}

		try {
			const [accounts, session] = await Promise.all([
				vscode.authentication.getAccounts(GITHUB_AUTH_PROVIDER),
				vscode.authentication.getSession(GITHUB_AUTH_PROVIDER, GITHUB_AUTH_SCOPES, { silent: true })
			]);
			const accountItems = accounts.length > 0
				? accounts.map((account) => {
					const selected = session?.account.id === account.id;
					return {
						label: account.label,
						description: selected ? 'Selected GitHub account' : undefined,
						isSelected: selected
					};
				})
				: [{ label: 'No GitHub accounts are signed in.' }];
			const repositoryOwnerItems = session
				? await this.getRepositoryOwnerItems(session)
				: [{ label: 'Selected GitHub account is not available to this extension.' }];

			return [
				{ label: 'GitHub accounts', children: accountItems },
				{ label: 'Repository owner', children: repositoryOwnerItems },
				{
					label: 'Remarks',
					children: this.remarks.length > 0
						? this.remarks.map((remark) => ({ label: remark }))
						: [{ label: `No remarks in ${RANGE_FILE_NAME}.` }]
				}
			];
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return [{ label: `Unable to load GitHub debug data: ${message}` }];
		}
	}

	/** @param {vscode.AuthenticationSession} session */
	async getRepositoryOwnerItems(session) {
		const headers = getGithubHeaders(session);
		const user = /** @type {GitHubUser} */ (
			await getGithubJson(`${GITHUB_API_URL}/user`, headers)
		);
		const organizations = await getGithubOrganizations(headers);
		const selectedOwner = vscode.workspace
			.getConfiguration('object-manager')
			.get(REPOSITORY_OWNER_SETTING);
		const selectedAccountId = vscode.workspace
			.getConfiguration('object-manager')
			.get(REPOSITORY_ACCOUNT_SETTING);
		const owners = [
			{ login: user.login, type: 'Personal account' },
			...organizations.map((organization) => ({ login: organization.login, type: 'Organization' }))
		];

		return owners.map((owner) => {
			const selected = selectedAccountId === session.account.id && selectedOwner === owner.login;
			return {
				label: owner.login,
				description: `${owner.type}${selected ? ` selected for ${RANGE_REPOSITORY_DISPLAY_NAME}` : ''}`,
				isSelected: selected
			};
		});
	}
}

// This method is called when your extension is deactivated
function deactivate() {
	disposeActiveFeatures();
}

module.exports = {
	activate,
	deactivate,
	isValidAlManifest,
	hasAlWorkspace,
	createApplicationRegistration,
	parseAlObjects,
	collectExtensionObjects,
	isObjectIdInRanges,
	classifyObjectSyncStatus,
	getApplicationObjectStatuses,
	checkAndUploadApplicationObject
}

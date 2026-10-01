// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const EXTENSION_CONFIG = require('./config.json');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
	parseAlObjects,
	isObjectIdInRanges,
	getNextAvailableObjectId,
	getObjectIdSlot,
	getDuplicateObjectKeys,
	getExtensionObjectKey,
	areRangesEqual,
	classifyObjectSyncStatus
} = require('./object-model');
const { activateOnTriggers } = require('./feature-lifecycle');
const { createGithubReservationStore } = require('./github-reservations');
const { createGithubRangeRepository } = require('./github-range-repository');
const { createObjectSyncService } = require('./object-sync');
const { createGitValidationTools } = require('./git-validation');
const {
	createGitSnapshotCollector,
	getGithubOwnerFromRemote,
	isPathWithin,
	analyzeRepositoryBranchObjects,
	formatBranchConflicts
} = require('./git-snapshots');
const {
	TreeDataProvider,
	ExtensionUsageDataProvider,
	OrganizationUsageDataProvider,
	GithubDebugDataProvider
} = require('./tree-data-providers');

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
const REPOSITORY_OWNER_SOURCE_SETTING = EXTENSION_CONFIG.settings.repositoryOwnerSource;
const APP_ID_PATTERN = new RegExp(EXTENSION_CONFIG.workspace.appIdPattern, 'i');
const execFileAsync = promisify(execFile);
let disposeActiveFeatures = () => {};
const gitValidationTools = createGitValidationTools({
	execFileAsync,
	fileSystem: require('fs/promises'),
	hookSourcePath: path.join(__dirname, 'git-validation-hook.js'),
	hookNames: ['pre-commit', 'pre-push'],
	marker: 'object-manager-validation-hook'
});
const {
	startValidationServer,
	prepareGitHookInstallation,
	installGitValidationHooksForRepository,
	removeGitValidationHooksForRepository
} = gitValidationTools;

/** @typedef {{ login: string }} GitHubUser */
/** @typedef {{ login: string }} GitHubOrganization */
/** @typedef {{ id: string, name: string, publisher: string, ranges: Array<{ from: number, to: number }> }} RangeRegistration */
/** @typedef {{ rangeOwner?: string, applicationId?: string }} ApplicationRangeTreeItem */
/** @typedef {{ 'object type': string, 'object name': string, 'object id': string }} ExtensionObject */
/** @typedef {'outOfRange' | 'conflict' | 'synced' | 'unsynced' | 'checking' | 'unavailable'} ObjectSyncStatus */
/** @typedef {ExtensionObject & { syncStatus: ObjectSyncStatus }} ExtensionUsageEntry */
/** @typedef {Record<string, string>} GitHubApiHeaders */
/** @typedef {{ rootUri: vscode.Uri, onDidCommit: (listener: () => void) => vscode.Disposable }} GitRepository */
/** @typedef {{ repositories: GitRepository[], onDidOpenRepository: (listener: (repository: GitRepository) => void) => vscode.Disposable }} GitApi */
/** @typedef {{ url: string, token: string, dispose: () => void }} GitValidationServer */
/** @typedef {{ label: string, description?: string, isSelected?: boolean, syncStatus?: ObjectSyncStatus, contextValue?: string, object?: ExtensionUsageEntry, command?: string, children?: DebugTreeItem[], rangeOwner?: string, applicationId?: string }} DebugTreeItem */

const githubReservationStore = createGithubReservationStore({
	reservationDirectory: OBJECT_RESERVATION_DIRECTORY,
	branch: RANGE_BRANCH,
	getGithubJson,
	getGithubResponseError
});
const {
	getApplicationObjectStatuses,
	checkAndUploadApplicationObject,
	upsertApplicationObjectReservation
} = githubReservationStore;
const gitSnapshotCollector = createGitSnapshotCollector({
	findFiles: (pattern) => Promise.resolve(vscode.workspace.findFiles(pattern)),
	readFile: (file) => Promise.resolve(vscode.workspace.fs.readFile(file)),
	execFileAsync,
	getGitRepositories,
	sourcePattern: EXTENSION_CONFIG.workspace.alSourcePattern,
	parseAlObjects
});
const {
	collectExtensionObjects,
	getApplicationRemoteOwner,
	collectRepositoryBranchObjects
} = gitSnapshotCollector;
const objectSyncService = createObjectSyncService({
	getApplicationManifest: getAlApplicationManifest,
	collectExtensionObjects,
	getGithubSession: (silent) => Promise.resolve(vscode.authentication.getSession(
		GITHUB_AUTH_PROVIDER,
		GITHUB_AUTH_SCOPES,
		{ silent }
	)),
	getRepositorySelection: () => {
		const configuration = vscode.workspace.getConfiguration('object-manager');
		return {
			owner: configuration.get(REPOSITORY_OWNER_SETTING),
			accountId: configuration.get(REPOSITORY_ACCOUNT_SETTING)
		};
	},
	getRepositoryUrl: (owner) => `${GITHUB_API_URL}/repos/${encodeURIComponent(owner)}/${RANGE_REPOSITORY_NAME}`,
	getGithubHeaders,
	getApplicationObjectStatuses,
	checkAndUploadApplicationObject,
	appManifestFileName: EXTENSION_CONFIG.workspace.appManifestFileName,
	showErrorMessage: (message) => vscode.window.showErrorMessage(message),
	showInformationMessage: (message) => vscode.window.showInformationMessage(message)
});
const {
	validateWorkspaceObjects,
	syncUnsyncedWorkspaceObjects,
	syncUnsyncedApplicationObjects,
	getObjectValidationFailures
} = objectSyncService;
const githubRangeRepository = createGithubRangeRepository({
	vscode,
	apiUrl: GITHUB_API_URL,
	repositoryName: RANGE_REPOSITORY_NAME,
	fileName: RANGE_FILE_NAME,
	branch: RANGE_BRANCH,
	initialData: INITIAL_RANGE_DATA,
	getGithubJson,
	getGithubResponseError,
	getApplicationManifest: getAlApplicationManifest,
	collectExtensionObjects,
	getApplicationObjectStatuses
});
const {
	ensureRangeRepository: ensureGithubRangeRepository,
	forceApplicationRangeToRepositoryData: forceGithubApplicationRangeToRepositoryData,
	createApplicationRegistration: createGithubApplicationRegistration
} = githubRangeRepository;

/** @param {vscode.ExtensionContext} context */
function activate(context) {
	/** @type {vscode.Disposable[]} */
	const featureDisposables = [];
	/** @type {Array<(listener: () => void) => vscode.Disposable>} */
	const workspaceTriggers = [
		(listener) => vscode.workspace.onDidChangeWorkspaceFolders(listener),
		(listener) => {
			const watcher = vscode.workspace.createFileSystemWatcher(EXTENSION_CONFIG.workspace.appManifestPattern);
			const subscriptions = [
				watcher.onDidChange(listener),
				watcher.onDidCreate(listener),
				watcher.onDidDelete(listener)
			];
			return {
				dispose() {
					watcher.dispose();
					for (const subscription of subscriptions) {
						subscription.dispose();
					}
				}
			};
		}
	];
	const stopFeatures = () => {
		for (const disposable of featureDisposables.splice(0)) {
			disposable.dispose();
		}
	};
	const workspaceLifecycle = activateOnTriggers(
		workspaceTriggers,
		hasAlWorkspace,
		() => startFeatures(featureDisposables),
		stopFeatures
	);
	context.subscriptions.push(workspaceLifecycle);
	disposeActiveFeatures = stopFeatures;
}

/** @param {vscode.Disposable[]} featureDisposables */
function startFeatures(featureDisposables) {
	console.log('Congratulations, your extension "object-manager" is now active!');
	const debugProvider = new GithubDebugDataProvider({
		hasAlWorkspace,
		getGithubHeaders,
		getGithubJson,
		getGithubOrganizations,
		providerId: GITHUB_AUTH_PROVIDER,
		scopes: GITHUB_AUTH_SCOPES,
		repositoryOwnerSetting: REPOSITORY_OWNER_SETTING,
		repositoryAccountSetting: REPOSITORY_ACCOUNT_SETTING
	});
	const organizationUsageProvider = new OrganizationUsageDataProvider(hasAlWorkspace);
	const extensionUsageProvider = new ExtensionUsageDataProvider();
	const rangeDiagnostics = vscode.languages.createDiagnosticCollection('object-manager');
	/** @type {string | undefined} */
		let currentApplicationId;
		let extensionObjectRefresh = Promise.resolve();
	const refreshExtensionObjects = () => {
		const nextRefresh = extensionObjectRefresh
			.then(async () => {
				const [objects, appManifest] = await Promise.all([
					collectExtensionObjects(),
					getAlApplicationManifest()
				]);
				currentApplicationId = appManifest?.manifest.id;
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
	/** @param {vscode.Uri} uri */
	const isAppManifestUri = (uri) => (vscode.workspace.workspaceFolders || []).some((folder) =>
		path.resolve(folder.uri.fsPath, EXTENSION_CONFIG.workspace.appManifestFileName).toLowerCase() ===
		path.resolve(uri.fsPath).toLowerCase()
	);
	const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
		if (isAppManifestUri(document.uri)) {
			try {
					const savedManifest = JSON.parse(document.getText());
					const savedApplicationId = typeof savedManifest.id === 'string' ? savedManifest.id : undefined;
				if (savedApplicationId !== currentApplicationId) {
					currentApplicationId = savedApplicationId;
					void refreshExtensionObjects().then(() => refreshRepositoryState());
				}
			} catch {}
			return;
			}
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
	let resettingGithubSelection = false;
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
			!resettingGithubSelection &&
			(
				event.affectsConfiguration(`object-manager.${REPOSITORY_OWNER_SETTING}`) ||
				event.affectsConfiguration(`object-manager.${REPOSITORY_ACCOUNT_SETTING}`)
			)
		) {
			void refreshRepositoryState();
		}
	});
	const repositoryCheckTimer = setInterval(
		() => void refreshRepositoryState(),
		getRepositoryCheckIntervalMs()
	);
	const validationServerReady = startValidationServer(() => validateWorkspaceObjects(extensionUsageProvider));
	void validationServerReady
		.then(async (server) => {
			const gitApi = await getGitApi();
			const observedRepositories = new Set();
			let postCommitSync = Promise.resolve();
			/** @param {GitRepository} repository */
			const observeRepositoryCommits = (repository) => {
				const repositoryPath = repository.rootUri.fsPath;
				if (observedRepositories.has(repositoryPath)) {
					return;
				}
				observedRepositories.add(repositoryPath);
				featureDisposables.push(repository.onDidCommit(() => {
					postCommitSync = postCommitSync
						.then(async () => { await syncUnsyncedWorkspaceObjects(extensionUsageProvider); })
						.catch((error) => {
							const message = error instanceof Error ? error.message : String(error);
							vscode.window.showErrorMessage(`Commit succeeded, but object reservations could not be synced: ${message}`);
						});
				}));
			};
			/** @param {GitRepository} repository */
			const installForRepository = async (repository) => {
				observeRepositoryCommits(repository);
				const installation = await prepareGitHookInstallation(repository);
				await installGitValidationHooksForRepository(installation, server);
			};
			featureDisposables.push(gitApi.onDidOpenRepository((repository) => {
				void installForRepository(repository).catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					vscode.window.showErrorMessage(`Unable to enable object validation for ${repository.rootUri.fsPath}: ${message}`);
				});
			}));
			await Promise.all(gitApi.repositories.map((repository) => installForRepository(repository)));
		})
		.catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			console.error('Unable to install Git validation hooks:', error);
			vscode.window.showErrorMessage(`Unable to enable automatic object validation for Git operations: ${message}`);
		});
	/** @type {GitValidationServer | undefined} */
	let validationServer;
	let validationServerDisposed = false;
	void validationServerReady.then((server) => {
		if (validationServerDisposed) {
			server.dispose();
		} else {
			validationServer = server;
		}
	});
	const validationServerDisposable = {
		dispose() {
			validationServerDisposed = true;
			validationServer?.dispose();
		}
	};

	const manageAccountPreference = vscode.commands.registerCommand(
		'object-manager.manageAccountPreference',
		async () => {
			resettingGithubSelection = true;
			try {
				await clearRepositoryOwner();
				await refreshRepositoryState(true);
			} finally {
				resettingGithubSelection = false;
			}
		}
	);
	const createUpdateApplicationRange = vscode.commands.registerCommand(
		'object-manager.createUpdateApplicationRange',
		() => refreshRepositoryState(false, true)
	);
	const forceApplicationRangeToRepository = vscode.commands.registerCommand(
		'object-manager.forceApplicationRangeToRepository',
		async (treeItem) => {
			let syncingOwner;
			let syncingApplicationId;
			try {
				const appManifest = await getAlApplicationManifest();
				if (!appManifest || !Array.isArray(appManifest.manifest.idRanges)) {
					vscode.window.showErrorMessage(`Unable to update ${RANGE_FILE_NAME} because ${EXTENSION_CONFIG.workspace.appManifestFileName} has no valid idRanges.`);
					return;
				}
				const rangeTreeItem = /** @type {ApplicationRangeTreeItem | undefined} */ (treeItem);
				if (
					!rangeTreeItem ||
					typeof rangeTreeItem.applicationId !== 'string' ||
					rangeTreeItem.applicationId !== appManifest.manifest.id ||
					typeof rangeTreeItem.rangeOwner !== 'string'
				) {
					return;
				}
				syncingOwner = rangeTreeItem.rangeOwner;
				syncingApplicationId = rangeTreeItem.applicationId;
				organizationUsageProvider.setRangeSyncing(syncingOwner, syncingApplicationId, true);
				const session = await selectGithubAccount();
				if (!session) {
					throw new Error('Sign in to GitHub before updating the application range.');
				}
				const configuration = vscode.workspace.getConfiguration('object-manager');
				const owner = configuration.get(REPOSITORY_OWNER_SETTING);
				const accountId = configuration.get(REPOSITORY_ACCOUNT_SETTING);
				if (typeof owner !== 'string' || owner !== rangeTreeItem.rangeOwner || accountId !== session.account.id) {
					vscode.window.showInformationMessage('Refresh organization usage and select its repository owner before updating this range.');
					await refreshRepositoryState(true);
					return;
				}

				const registration = createGithubApplicationRegistration(appManifest.manifest);
				const changed = await forceGithubApplicationRangeToRepositoryData(
					owner,
					registration,
					getGithubHeaders(session)
				);
				vscode.window.showInformationMessage(
					changed ? `Updated ${RANGE_FILE_NAME} with the ${EXTENSION_CONFIG.workspace.appManifestFileName} range.` : `${RANGE_FILE_NAME} already has the ${EXTENSION_CONFIG.workspace.appManifestFileName} range.`
				);
				await refreshRepositoryState();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to update ${RANGE_FILE_NAME} with the application range: ${message}`);
			} finally {
				if (syncingOwner && syncingApplicationId) {
					organizationUsageProvider.setRangeSyncing(syncingOwner, syncingApplicationId, false);
				}
			}
		}
	);
	const forceApplicationRangeToRepositoryBusy = vscode.commands.registerCommand(
		'object-manager.forceApplicationRangeToRepositoryBusy',
		() => undefined
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
	const syncRepositoryObjects = vscode.commands.registerCommand(
		'object-manager.syncRepositoryObjects',
		async () => {
			try {
				const appManifest = await getAlApplicationManifest();
				if (!appManifest || !Array.isArray(appManifest.manifest.idRanges)) {
					vscode.window.showErrorMessage(`Unable to sync repository objects because ${EXTENSION_CONFIG.workspace.appManifestFileName} has no valid idRanges.`);
					return;
				}
				const gitRepositories = await getGitRepositories();
				const matchingRepositories = gitRepositories.filter(({ rootUri }) =>
					isPathWithin(rootUri.fsPath, path.dirname(appManifest.uri.fsPath))
				);
				if (matchingRepositories.length === 0) {
					vscode.window.showInformationMessage('Open this AL workspace inside a Git repository before syncing its objects.');
					return;
				}
				let repository = matchingRepositories[0];
				if (matchingRepositories.length > 1) {
					const selection = await vscode.window.showQuickPick(matchingRepositories.map((item) => ({
						label: item.rootUri.fsPath,
						repository: item
					})), { placeHolder: 'Select the Git repository to sync' });
					if (!selection) {
						return;
					}
					repository = selection.repository;
				}
				const branchData = await collectRepositoryBranchObjects(
					repository.rootUri.fsPath,
					await collectExtensionObjects(true)
				);
				const analysis = analyzeRepositoryBranchObjects(branchData, appManifest.manifest.idRanges);
				const currentBranch = branchData.find(({ isCurrent }) => isCurrent);
				extensionUsageProvider.setObjects(currentBranch?.objects || [], appManifest.manifest.idRanges);
				const currentConflicts = analysis.conflicts.filter(({ branch }) => branch === currentBranch?.name);
				if (currentConflicts.length > 0) {
					const action = 'Open Extension Usage';
					const selection = await vscode.window.showErrorMessage(
						`Sync stopped. Fix current-branch object conflicts in Extension Usage: ${formatBranchConflicts(currentConflicts)}`,
						action
					);
					if (selection === action) {
						await vscode.commands.executeCommand('object-manager.extensionUsage.focus');
					}
					return;
				}
				const session = await selectGithubAccount();
				if (!session) {
					throw new Error('Sign in to GitHub before syncing repository objects.');
				}
				const configuration = vscode.workspace.getConfiguration('object-manager');
				const owner = configuration.get(REPOSITORY_OWNER_SETTING);
				const accountId = configuration.get(REPOSITORY_ACCOUNT_SETTING);
				if (typeof owner !== 'string' || !owner || accountId !== session.account.id) {
					vscode.window.showInformationMessage('Choose the repository owner before syncing repository objects.');
					await refreshRepositoryState(true);
					return;
				}
				const repositoryUrl = `${GITHUB_API_URL}/repos/${encodeURIComponent(owner)}/${RANGE_REPOSITORY_NAME}`;
				const headers = getGithubHeaders(session);
				const statuses = await getApplicationObjectStatuses(repositoryUrl, analysis.objects, appManifest.manifest.idRanges, headers);
				extensionUsageProvider.setSyncStatuses(statuses);
				const currentObjectKeys = new Set((currentBranch?.objects || []).map(getExtensionObjectKey));
				const repositoryConflicts = statuses
					.filter(({ object, status }) => currentObjectKeys.has(getExtensionObjectKey(object)) && (status === 'conflict' || status === 'outOfRange'))
					.map(({ object, status }) => ({
						branch: currentBranch?.name || 'current branch',
						object,
						reason: /** @type {'conflict' | 'outOfRange'} */ (status)
					}));
				if (repositoryConflicts.length > 0) {
					const action = 'Open Extension Usage';
					const selection = await vscode.window.showErrorMessage(
						`Sync stopped. Fix current-branch object conflicts in Extension Usage: ${formatBranchConflicts(repositoryConflicts)}`,
						action
					);
					if (selection === action) {
						await vscode.commands.executeCommand('object-manager.extensionUsage.focus');
					}
					return;
				}
				const writableStatuses = statuses.filter(({ object, status }) =>
					analysis.syncableObjectKeys.has(getExtensionObjectKey(object)) && status !== 'conflict' && status !== 'outOfRange'
				);
				let synced = 0;
				let failed = 0;
				for (const { object } of writableStatuses) {
					try {
						const status = await upsertApplicationObjectReservation(repositoryUrl, object, appManifest.manifest.idRanges, headers);
						extensionUsageProvider.setObjectSyncStatus(object, status);
						if (status === 'synced') {
							synced++;
						} else {
							failed++;
						}
					} catch {
						extensionUsageProvider.setObjectSyncStatus(object, 'unavailable');
						failed++;
					}
				}
				const otherBranchConflicts = analysis.conflicts.filter(({ branch }) => branch !== currentBranch?.name);
				if (otherBranchConflicts.length > 0) {
					vscode.window.showInformationMessage(
						`Synced ${synced} object${synced === 1 ? '' : 's'}. Conflicts in other branches: ${formatBranchConflicts(otherBranchConflicts)}`
					);
				} else if (failed > 0) {
					vscode.window.showErrorMessage(`Synced ${synced} objects; ${failed} could not be synced. See Extension Usage.`);
				} else {
					vscode.window.showInformationMessage(`Synced ${synced} object${synced === 1 ? '' : 's'} from the repository branches.`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to sync repository objects: ${message}`);
			}
		}
	);
	const suggestAvailableObjectId = vscode.commands.registerCommand(
		'object-manager.suggestAvailableObjectId',
		async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.languageId !== 'al') {
				return;
			}
			const position = editor.selection.active;
			const slot = getObjectIdSlot(editor.document.lineAt(position.line).text, position.character);
			if (!slot) {
				await vscode.commands.executeCommand('editor.action.triggerSuggest');
				return;
			}
			const objectId = extensionUsageProvider.getNextAvailableObjectId(slot.objectType);
			if (!objectId) {
				vscode.window.showInformationMessage(`No available ${slot.objectType} ID remains in app.json idRanges.`);
				return;
			}
			await editor.edit((editBuilder) => editBuilder.replace(
				new vscode.Range(position.line, slot.start, position.line, slot.end),
				objectId
			));
			const cursor = new vscode.Position(position.line, slot.start + objectId.length);
			editor.selection = new vscode.Selection(cursor, cursor);
		}
	);
	const installGitValidationHooks = vscode.commands.registerCommand(
		'object-manager.installGitValidationHooks',
		async () => {
			try {
			await execFileAsync(process.platform === 'win32' ? 'node.exe' : 'node', ['--version']);
				const server = await validationServerReady;
				const repositories = /** @type {GitRepository[]} */ (await getGitRepositories());
				if (repositories.length === 0) {
					vscode.window.showInformationMessage('Open a Git repository to install object validation hooks.');
					return;
				}
				const installations = await Promise.all(repositories.map((repository) => prepareGitHookInstallation(repository)));
				for (const installation of installations) {
					await installGitValidationHooksForRepository(installation, server);
				}
				vscode.window.showInformationMessage('Object validation hooks installed for open Git repositories.');
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to install object validation hooks: ${message}`);
			}
		}
	);
	const removeGitValidationHooks = vscode.commands.registerCommand(
		'object-manager.removeGitValidationHooks',
		async () => {
			try {
				const repositories = /** @type {GitRepository[]} */ (await getGitRepositories());
				for (const repository of repositories) {
					await removeGitValidationHooksForRepository(repository);
				}
				vscode.window.showInformationMessage('Object validation hooks removed from open Git repositories.');
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to remove object validation hooks: ${message}`);
			}
		}
	);

	featureDisposables.push(
		manageAccountPreference,
		createUpdateApplicationRange,
		forceApplicationRangeToRepository,
		forceApplicationRangeToRepositoryBusy,
		syncObjectReservation,
		syncObjectReservationBusy,
		syncRepositoryObjects,
		suggestAvailableObjectId,
		installGitValidationHooks,
		removeGitValidationHooks,
		validationServerDisposable,
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
			{ label: 'Object Manager: Reset GitHub Account and Organization Selection', command: 'object-manager.manageAccountPreference' },
			{ label: 'Object Manager: Create or Update Application Range', command: 'object-manager.createUpdateApplicationRange' },
			{ label: 'Object Manager: Sync Object Reservation', command: 'object-manager.syncObjectReservation' },
			{ label: 'Object Manager: Sync Existing Repository Objects', command: 'object-manager.syncRepositoryObjects' },
			{ label: 'Object Manager: Install Git Validation Hooks', command: 'object-manager.installGitValidationHooks' },
			{ label: 'Object Manager: Remove Git Validation Hooks', command: 'object-manager.removeGitValidationHooks' }
		])),
		vscode.window.registerTreeDataProvider('object-manager.extensionUsage', extensionUsageProvider),
		vscode.window.registerTreeDataProvider('object-manager.organizationUsage', organizationUsageProvider),
		vscode.window.registerTreeDataProvider('object-manager.debug', debugProvider)
	);
}

/** @returns {Promise<GitApi>} */
async function getGitApi() {
	const gitExtension = vscode.extensions.getExtension('vscode.git');
	if (!gitExtension) {
		throw new Error('The built-in Git extension is unavailable.');
	}
	const exports = await gitExtension.activate();
	if (typeof exports.getAPI !== 'function') {
		throw new Error('The built-in Git extension API is unavailable.');
	}
	return /** @type {GitApi} */ (exports.getAPI(1));
}

async function getGitRepositories() {
	return (await getGitApi()).repositories;
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
		const configuredOwnerSource = configuration.get(REPOSITORY_OWNER_SOURCE_SETTING);
		const configuredOwnerIsValid = configuredAccountId === session.account.id &&
			typeof configuredOwner === 'string' && validOwners.includes(configuredOwner);
		const appManifest = await getAlApplicationManifest();
		const remoteOwner = appManifest ? await getApplicationRemoteOwner(appManifest) : undefined;
		const matchingRemoteOwner = validOwners.find((owner) => owner.toLowerCase() === remoteOwner?.toLowerCase());

		if (
			!showAccountPicker && matchingRemoteOwner &&
			(!configuredOwnerIsValid || configuredOwnerSource === 'remote' || configuredOwnerSource === 'default')
		) {
			await saveRepositoryOwner(matchingRemoteOwner, session.account.id, 'remote');
			await ensureGithubRangeRepository(
				matchingRemoteOwner, accountLogin, headers, organizationUsageProvider, debugProvider,
				rangeDiagnostics, manualRangeUpdate, extensionUsageProvider
			);
			return;
		}

		if (organizations.length === 0) {
			await saveRepositoryOwner(accountLogin, session.account.id, 'default');
			await ensureGithubRangeRepository(
				accountLogin, accountLogin, headers, organizationUsageProvider, debugProvider,
				rangeDiagnostics, manualRangeUpdate, extensionUsageProvider
			);
			return;
		}

		const staleRemoteOwner = Boolean(
			remoteOwner && !matchingRemoteOwner &&
			(configuredOwnerSource === 'remote' || configuredOwnerSource === 'default')
		);
		if (!showAccountPicker && configuredOwnerIsValid && !staleRemoteOwner) {
			await ensureGithubRangeRepository(
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
			await saveRepositoryOwner(selection.owner, session.account.id, 'user');
			await ensureGithubRangeRepository(
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
function saveRepositoryOwner(owner, accountId, source = 'default') {
	const configuration = vscode.workspace.getConfiguration('object-manager');
	return Promise.all([
		configuration.update(REPOSITORY_OWNER_SETTING, owner, vscode.ConfigurationTarget.Workspace),
		configuration.update(REPOSITORY_ACCOUNT_SETTING, accountId, vscode.ConfigurationTarget.Workspace),
		configuration.update(REPOSITORY_OWNER_SOURCE_SETTING, source, vscode.ConfigurationTarget.Workspace)
	]);
}

function clearRepositoryOwner() {
	const configuration = vscode.workspace.getConfiguration('object-manager');
	return Promise.all([
		configuration.update(REPOSITORY_OWNER_SETTING, '', vscode.ConfigurationTarget.Workspace),
		configuration.update(REPOSITORY_ACCOUNT_SETTING, '', vscode.ConfigurationTarget.Workspace),
		configuration.update(REPOSITORY_OWNER_SOURCE_SETTING, '', vscode.ConfigurationTarget.Workspace)
	]);
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
	createApplicationRegistration: createGithubApplicationRegistration,
	areRangesEqual,
	forceApplicationRangeToRepositoryData: forceGithubApplicationRangeToRepositoryData,
	parseAlObjects,
	collectExtensionObjects,
	isObjectIdInRanges,
	getNextAvailableObjectId,
	getObjectIdSlot,
	getDuplicateObjectKeys,
	classifyObjectSyncStatus,
	getApplicationObjectStatuses,
	getObjectValidationFailures,
	collectRepositoryBranchObjects,
	analyzeRepositoryBranchObjects,
	getGithubOwnerFromRemote,
	syncUnsyncedApplicationObjects,
	startValidationServer,
	prepareGitHookInstallation,
	installGitValidationHooksForRepository,
	checkAndUploadApplicationObject,
	upsertApplicationObjectReservation
}

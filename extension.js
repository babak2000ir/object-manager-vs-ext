// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const crypto = require('crypto');
const EXTENSION_CONFIG = require('./config.json');
const fs = require('fs/promises');
const http = require('http');
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
	normalizeObjectFilename,
	classifyObjectSyncStatus
} = require('./object-model');
const { activateOnTriggers } = require('./feature-lifecycle');
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
const GIT_HOOKS = ['pre-commit', 'pre-push'];
const GIT_HOOK_MARKER = 'object-manager-validation-hook';
const promptedRangeMismatches = new Set();
let disposeActiveFeatures = () => {};

/** @typedef {{ login: string }} GitHubUser */
/** @typedef {{ login: string }} GitHubOrganization */
/** @typedef {{ default_branch: string }} GitHubRepository */
/** @typedef {{ content: string, sha: string }} GitHubContentsFile */
/** @typedef {{ object: { sha: string } }} GitHubReference */
/** @typedef {{ id: string, name: string, publisher: string, ranges: Array<{ from: number, to: number }> }} RangeRegistration */
/** @typedef {{ Remarks: string[], ranges: RangeRegistration[] }} RangeData */
/** @typedef {{ rangeOwner?: string, applicationId?: string }} ApplicationRangeTreeItem */
/** @typedef {{ 'object type': string, 'object name': string, 'object id': string }} ExtensionObject */
/** @typedef {'outOfRange' | 'conflict' | 'synced' | 'unsynced' | 'checking' | 'unavailable'} ObjectSyncStatus */
/** @typedef {ExtensionObject & { syncStatus: ObjectSyncStatus }} ExtensionUsageEntry */
/** @typedef {Record<string, string>} GitHubApiHeaders */
/** @typedef {{ rootUri: vscode.Uri, onDidCommit: (listener: () => void) => vscode.Disposable }} GitRepository */
/** @typedef {{ repositories: GitRepository[], onDidOpenRepository: (listener: (repository: GitRepository) => void) => vscode.Disposable }} GitApi */
/** @typedef {{ url: string, token: string, dispose: () => void }} GitValidationServer */
/** @typedef {{ label: string, description?: string, isSelected?: boolean, syncStatus?: ObjectSyncStatus, contextValue?: string, object?: ExtensionUsageEntry, command?: string, children?: DebugTreeItem[], rangeOwner?: string, applicationId?: string }} DebugTreeItem */

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
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

				const registration = createApplicationRegistration(appManifest.manifest);
				const changed = await forceApplicationRangeToRepositoryData(
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
				const currentObjectKeys = new Set((currentBranch?.objects || []).map(getObjectKey));
				const repositoryConflicts = statuses
					.filter(({ object, status }) => currentObjectKeys.has(getObjectKey(object)) && (status === 'conflict' || status === 'outOfRange'))
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
					analysis.syncableObjectKeys.has(getObjectKey(object)) && status !== 'conflict' && status !== 'outOfRange'
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

/** @param {() => Promise<{ ok: boolean, message?: string }>} validate */
function startValidationServer(validate) {
	const token = crypto.randomBytes(32).toString('hex');
	const server = http.createServer(async (request, response) => {
		if (request.method !== 'POST' || request.url !== '/validate') {
			response.writeHead(404).end();
			return;
		}
		if (request.headers.authorization !== `Bearer ${token}`) {
			response.writeHead(403).end();
			return;
		}
		try {
			const result = await validate();
			response.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify(result));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			response.writeHead(503, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ ok: false, message }));
		}
	});
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close();
				reject(new Error('Unable to start the local object validation server.'));
				return;
			}
			resolve({
				url: `http://127.0.0.1:${address.port}/validate`,
				token,
				dispose: () => server.close()
			});
		});
	});
}

/** @param {ExtensionUsageDataProvider} extensionUsageProvider */
async function validateWorkspaceObjects(extensionUsageProvider) {
	const appManifest = await getAlApplicationManifest();
	if (!appManifest || !Array.isArray(appManifest.manifest.idRanges)) {
		throw new Error(`Unable to check objects because ${EXTENSION_CONFIG.workspace.appManifestFileName} has no valid idRanges.`);
	}
	const objects = await collectExtensionObjects(true);
	extensionUsageProvider.setObjects(objects, appManifest.manifest.idRanges);
	if (objects.length === 0) {
		return { ok: true };
	}
	const session = await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER, GITHUB_AUTH_SCOPES, { silent: true });
	if (!session) {
		extensionUsageProvider.setSyncUnavailable('Sign in to GitHub to validate object reservations before committing or pushing.');
		throw new Error('Sign in to GitHub to validate object reservations before committing or pushing.');
	}
	const configuration = vscode.workspace.getConfiguration('object-manager');
	const owner = configuration.get(REPOSITORY_OWNER_SETTING);
	const accountId = configuration.get(REPOSITORY_ACCOUNT_SETTING);
	if (typeof owner !== 'string' || !owner || accountId !== session.account.id) {
		extensionUsageProvider.setSyncUnavailable('Choose the GitHub repository owner before validating object reservations.');
		throw new Error('Choose the GitHub repository owner for object validation before committing or pushing.');
	}
	const repositoryUrl = `${GITHUB_API_URL}/repos/${encodeURIComponent(owner)}/${RANGE_REPOSITORY_NAME}`;
	let statuses;
	try {
		statuses = await getApplicationObjectStatuses(
			repositoryUrl,
			objects,
			appManifest.manifest.idRanges,
			getGithubHeaders(session)
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		extensionUsageProvider.setSyncUnavailable(message);
		throw error;
	}
	extensionUsageProvider.setSyncStatuses(statuses);
	const failures = getObjectValidationFailures(statuses);
	if (failures.length > 0) {
		const details = failures.map(({ object, status }) =>
			`${object['object type']} ${object['object name']} (${object['object id']}): ${status === 'conflict' ? 'reservation conflict' : 'ID is out of range'}`
		).join('; ');
		vscode.window.showErrorMessage(`Git operation blocked. Refresh object data and resolve: ${details}`);
		return { ok: false, message: `Resolve object validation errors: ${details}` };
	}
	return { ok: true };
}

/** @param {ExtensionUsageDataProvider} extensionUsageProvider */
async function syncUnsyncedWorkspaceObjects(extensionUsageProvider) {
	const appManifest = await getAlApplicationManifest();
	if (!appManifest || !Array.isArray(appManifest.manifest.idRanges)) {
		throw new Error(`Unable to sync objects because ${EXTENSION_CONFIG.workspace.appManifestFileName} has no valid idRanges.`);
	}
	const objects = await collectExtensionObjects(true);
	extensionUsageProvider.setObjects(objects, appManifest.manifest.idRanges);
	if (objects.length === 0) {
		return 0;
	}
	const session = await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER, GITHUB_AUTH_SCOPES, { silent: true });
	if (!session) {
		throw new Error('Sign in to GitHub to sync object reservations after committing.');
	}
	const configuration = vscode.workspace.getConfiguration('object-manager');
	const owner = configuration.get(REPOSITORY_OWNER_SETTING);
	const accountId = configuration.get(REPOSITORY_ACCOUNT_SETTING);
	if (typeof owner !== 'string' || !owner || accountId !== session.account.id) {
		throw new Error('Choose the GitHub repository owner to sync object reservations after committing.');
	}
	const repositoryUrl = `${GITHUB_API_URL}/repos/${encodeURIComponent(owner)}/${RANGE_REPOSITORY_NAME}`;
	const headers = getGithubHeaders(session);
	const statuses = await getApplicationObjectStatuses(
		repositoryUrl,
		objects,
		appManifest.manifest.idRanges,
		headers
	);
	extensionUsageProvider.setSyncStatuses(statuses);
	const results = await syncUnsyncedApplicationObjects(
		repositoryUrl,
		statuses,
		appManifest.manifest.idRanges,
		headers,
		extensionUsageProvider
	);
	if (results.synced > 0) {
		vscode.window.showInformationMessage(`Synced ${results.synced} object reservation${results.synced === 1 ? '' : 's'} after commit.`);
	}
	if (results.failed > 0) {
		vscode.window.showErrorMessage(`Commit succeeded, but ${results.failed} object reservation${results.failed === 1 ? '' : 's'} could not be synced. See the Extension Usage view.`);
	}
	return results.synced;
}

/**
 * @param {string} repositoryUrl
 * @param {Array<{ object: ExtensionObject, status: ObjectSyncStatus }>} statuses
 * @param {unknown} ranges
 * @param {GitHubApiHeaders} headers
 * @param {ExtensionUsageDataProvider} extensionUsageProvider
 */
async function syncUnsyncedApplicationObjects(repositoryUrl, statuses, ranges, headers, extensionUsageProvider) {
	const unsyncedObjects = statuses.filter(({ status }) => status === 'unsynced');
	let synced = 0;
	let failed = 0;
	for (const { object } of unsyncedObjects) {
		extensionUsageProvider.setObjectSyncing(object, true);
		try {
			const status = await checkAndUploadApplicationObject(repositoryUrl, object, ranges, headers);
			extensionUsageProvider.setObjectSyncStatus(object, status);
			if (status === 'synced') {
				synced++;
			} else {
				failed++;
			}
		} catch {
			extensionUsageProvider.setObjectSyncStatus(object, 'unavailable');
			failed++;
		} finally {
			extensionUsageProvider.setObjectSyncing(object, false);
		}
	}
	return { synced, failed };
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

/** @param {string} parentPath @param {string} childPath */
function isPathWithin(parentPath, childPath) {
	const relativePath = path.relative(parentPath, childPath);
	return relativePath === '' || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath));
}

/** @param {string} remoteUrl */
function getGithubOwnerFromRemote(remoteUrl) {
	const scpMatch = /^(?:[^@/]+@)?github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(remoteUrl);
	let host;
	let repositoryPath;
	if (scpMatch) {
		host = 'github.com';
		repositoryPath = `/${scpMatch[1]}/${scpMatch[2]}`;
	} else {
		try {
			const remote = new URL(remoteUrl);
			host = remote.hostname.toLowerCase();
			repositoryPath = remote.pathname;
		} catch {
			return undefined;
		}
	}
	if (host !== 'github.com') {
		return undefined;
	}
	const repositorySegments = repositoryPath.split('/').filter(Boolean);
	if (repositorySegments.length !== 2) {
		return undefined;
	}
	const [owner] = repositorySegments;
	try {
		return decodeURIComponent(owner);
	} catch {
		return undefined;
	}
}

/** @param {{ uri: vscode.Uri }} appManifest */
async function getApplicationRemoteOwner(appManifest) {
	try {
		const appDirectory = path.dirname(appManifest.uri.fsPath);
		const repositories = (await getGitRepositories())
			.filter(({ rootUri }) => isPathWithin(rootUri.fsPath, appDirectory))
			.sort((left, right) => right.rootUri.fsPath.length - left.rootUri.fsPath.length);
		const repository = repositories[0];
		if (!repository) {
			return undefined;
		}
		const { stdout: remoteOutput } = await execFileAsync('git', ['remote'], { cwd: repository.rootUri.fsPath });
		const remotes = remoteOutput.split(/\r?\n/).map((remote) => remote.trim()).filter(Boolean);
		const remoteName = remotes.includes('origin') ? 'origin' : remotes[0];
		if (!remoteName) {
			return undefined;
		}
		const { stdout: remoteUrl } = await execFileAsync(
			'git', ['remote', 'get-url', remoteName], { cwd: repository.rootUri.fsPath }
		);
		return getGithubOwnerFromRemote(remoteUrl.trim());
	} catch {
		return undefined;
	}
}

/** @param {string} rootPath @param {ExtensionObject[]} currentObjects */
async function collectRepositoryBranchObjects(rootPath, currentObjects) {
	const { stdout: currentBranchOutput } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: rootPath });
	const currentBranchName = currentBranchOutput.trim();
	if (!currentBranchName || currentBranchName === 'HEAD') {
		throw new Error('Check out a branch before syncing repository objects.');
	}
	const { stdout: branchOutput } = await execFileAsync(
		'git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], { cwd: rootPath }
	);
	const branchNames = [...new Set([
		currentBranchName,
		...branchOutput.split(/\r?\n/).map((branch) => branch.trim()).filter((branch) => branch && !branch.endsWith('/HEAD'))
	])];
	return Promise.all(branchNames.map(async (branch) => {
		if (branch === currentBranchName) {
			return { name: branch, isCurrent: true, objects: currentObjects };
		}
		const { stdout: fileOutput } = await execFileAsync(
			'git', ['ls-tree', '-r', '-z', '--name-only', branch, '--', '*.al'],
			{ cwd: rootPath, maxBuffer: 50 * 1024 * 1024 }
		);
		const files = fileOutput.split('\0').filter(Boolean);
		const objects = [];
		for (const file of files) {
			const { stdout: source } = await execFileAsync(
				'git', ['show', `${branch}:${file}`], { cwd: rootPath, maxBuffer: 50 * 1024 * 1024 }
			);
			objects.push(...parseAlObjects(source));
		}
		return { name: branch, isCurrent: false, objects };
	}));
}

/** @param {Array<{ name: string, isCurrent: boolean, objects: ExtensionObject[] }>} branches @param {unknown} ranges */
function analyzeRepositoryBranchObjects(branches, ranges) {
	/** @type {Array<{ branch: string, object: ExtensionObject, reason: 'conflict' | 'outOfRange' }>} */
	const conflicts = [];
	const currentBranch = branches.find(({ isCurrent }) => isCurrent);
	const currentNames = new Map((currentBranch?.objects || []).map((object) => [getExtensionObjectKey(object), object['object name']]));
	/** @type {Map<string, Array<{ branch: string, object: ExtensionObject }>>} */
	const objectsByKey = new Map();
	for (const { name, objects } of branches) {
		const duplicates = getDuplicateObjectKeys(objects);
		for (const object of objects) {
			const key = getExtensionObjectKey(object);
			const entries = objectsByKey.get(key) || [];
			entries.push({ branch: name, object });
			objectsByKey.set(key, entries);
			if (!isObjectIdInRanges(object['object id'], ranges)) {
				conflicts.push({ branch: name, object, reason: 'outOfRange' });
			} else if (duplicates.has(key)) {
				conflicts.push({ branch: name, object, reason: 'conflict' });
			}
		}
	}
	for (const entries of objectsByKey.values()) {
		const names = new Set(entries.map(({ object }) => object['object name']));
		if (names.size < 2) {
			continue;
		}
		const currentName = currentNames.get(getExtensionObjectKey(entries[0].object));
		for (const entry of entries) {
			if (entry.object['object name'] !== currentName) {
				conflicts.push({ ...entry, reason: 'conflict' });
			}
		}
	}
	const syncableObjectKeys = new Set();
	const syncObjects = [];
	for (const [key, entries] of objectsByKey) {
		const inRangeEntries = entries.filter(({ object }) => isObjectIdInRanges(object['object id'], ranges));
		if (inRangeEntries.length === 0) {
			continue;
		}
		const names = new Set(inRangeEntries.map(({ object }) => object['object name']));
		const selected = currentBranch
			? inRangeEntries.find(({ branch }) => branch === currentBranch.name)
			: undefined;
		if (names.size > 1 && !selected) {
			continue;
		}
		const object = selected?.object || inRangeEntries[0].object;
		syncableObjectKeys.add(key);
		syncObjects.push(object);
	}
	return { conflicts, objects: syncObjects, syncableObjectKeys };
}

/** @param {Array<{ branch: string, object: ExtensionObject, reason: 'conflict' | 'outOfRange' }>} conflicts */
function formatBranchConflicts(conflicts) {
	const uniqueConflicts = new Map(conflicts.map(({ branch, object, reason }) => [
		`${branch}:${getExtensionObjectKey(object)}:${object['object name']}:${reason}`,
		`${branch}: ${object['object type']} ${object['object id']} ${object['object name']} (${reason === 'outOfRange' ? 'out of range' : 'different names use the same ID'})`
	]));
	return [...uniqueConflicts.values()].join('; ');
}

/** @param {ExtensionObject} object */
function getObjectKey(object) {
	return getExtensionObjectKey(object);
}

/** @param {{ rootUri: vscode.Uri }} repository */
async function prepareGitHookInstallation(repository) {
	const rootPath = repository.rootUri.fsPath;
	const { stdout: configuredHooksPath } = await execFileAsync('git', ['config', '--get', 'core.hooksPath'], { cwd: rootPath }).catch((error) => {
		if (error.code === 1) {
			return { stdout: '' };
		}
		throw error;
	});
	if (configuredHooksPath.trim()) {
		throw new Error(`A custom core.hooksPath is configured for ${rootPath}; refusing to change it.`);
	}
	const { stdout: hooksPath } = await execFileAsync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: rootPath });
	const hooksDirectory = path.resolve(rootPath, hooksPath.trim());
	const validationConfigPath = path.resolve(hooksDirectory, '..', 'object-manager-validation.json');
	for (const hookName of GIT_HOOKS) {
		const hookPath = path.join(hooksDirectory, hookName);
		try {
			const existingHook = await fs.readFile(hookPath, 'utf8');
			if (!existingHook.includes(GIT_HOOK_MARKER)) {
				throw new Error(`A ${hookName} hook already exists for ${rootPath}; it was left unchanged.`);
			}
		} catch (error) {
			if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
				throw error;
			}
		}
	}
	return { rootPath, hooksDirectory, validationConfigPath };
}

/** @param {{ rootPath: string, hooksDirectory: string, validationConfigPath: string }} installation @param {{ url: string, token: string }} server */
async function installGitValidationHooksForRepository(installation, server) {
	const hookSource = await fs.readFile(path.join(__dirname, 'git-validation-hook.js'));
	await fs.mkdir(installation.hooksDirectory, { recursive: true });
	for (const hookName of GIT_HOOKS) {
		const hookPath = path.join(installation.hooksDirectory, hookName);
		await fs.writeFile(hookPath, hookSource);
		await fs.chmod(hookPath, 0o755);
	}
	await fs.writeFile(installation.validationConfigPath, JSON.stringify(server));
}

/** @param {{ rootUri: vscode.Uri }} repository */
async function removeGitValidationHooksForRepository(repository) {
	const installation = await prepareGitHookInstallation(repository);
	for (const hookName of GIT_HOOKS) {
		const hookPath = path.join(installation.hooksDirectory, hookName);
		try {
			const existingHook = await fs.readFile(hookPath, 'utf8');
			if (existingHook.includes(GIT_HOOK_MARKER)) {
				await fs.rm(hookPath);
			}
		} catch (error) {
			if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
				throw error;
			}
		}
	}
	await fs.rm(installation.validationConfigPath, { force: true });
}

/** @returns {Promise<ExtensionObject[]>} */
async function collectExtensionObjects(failOnReadError = false) {
	const files = (await vscode.workspace.findFiles(EXTENSION_CONFIG.workspace.alSourcePattern)).sort((left, right) =>
		left.toString().localeCompare(right.toString())
	);
	/** @type {ExtensionObject[]} */
	const objects = [];
	for (const file of files) {
		try {
			const content = await vscode.workspace.fs.readFile(file);
			objects.push(...parseAlObjects(Buffer.from(content).toString('utf8')));
		} catch (error) {
			if (failOnReadError) {
				throw new Error(`Unable to read AL source file ${file.toString()}: ${error instanceof Error ? error.message : String(error)}`);
			}
			console.warn(`Unable to read AL source file ${file.toString()}:`, error);
		}
	}
	return objects.sort((left, right) =>
		left['object type'].localeCompare(right['object type']) ||
		Number(left['object id']) - Number(right['object id'])
	);
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
	const duplicateObjectKeys = getDuplicateObjectKeys(objects);
	return Promise.all(objects.map(async (object) => {
		if (duplicateObjectKeys.has(`${object['object type']}:${object['object id']}`)) {
			return { object, status: 'conflict' };
		}
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

/** @param {Array<{ object: ExtensionObject, status: string }>} statuses */
function getObjectValidationFailures(statuses) {
	return statuses.filter(({ status }) => status === 'conflict' || status === 'outOfRange');
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

/** @param {string} repositoryUrl @param {ExtensionObject} object @param {unknown} ranges @param {GitHubApiHeaders} headers */
async function upsertApplicationObjectReservation(repositoryUrl, object, ranges, headers) {
	if (!isObjectIdInRanges(object['object id'], ranges)) {
		return 'outOfRange';
	}
	const objectType = object['object type'].toLowerCase();
	const folderPath = `${OBJECT_RESERVATION_DIRECTORY}/${encodeURIComponent(objectType)}`;
	const folderContents = await getObjectTypeFolderContents(repositoryUrl, objectType, headers);
	const expectedName = normalizeObjectFilename(`${objectType}${object['object id']}`);
	const matchingFiles = folderContents.filter((entry) => {
		const file = /** @type {{ type?: unknown, name?: unknown }} */ (entry);
		return file && file.type === 'file' && typeof file.name === 'string' && normalizeObjectFilename(file.name) === expectedName;
	});
	if (matchingFiles.length === 0) {
		return checkAndUploadApplicationObject(repositoryUrl, object, ranges, headers);
	}
	if (matchingFiles.length > 1) {
		return 'conflict';
	}
	const existing = /** @type {{ url?: unknown, name?: unknown }} */ (matchingFiles[0]);
	if (typeof existing.url !== 'string' || typeof existing.name !== 'string') {
		return 'conflict';
	}
	const existingFile = /** @type {GitHubContentsFile} */ (await getGithubJson(existing.url, headers));
	const existingContent = Buffer.from(existingFile.content.replace(/\s/g, ''), 'base64').toString('utf8');
	let existingRecord;
	try {
		existingRecord = JSON.parse(existingContent);
	} catch {
		return 'conflict';
	}
	if (classifyObjectSyncStatus(object, ranges, existingRecord) !== 'synced' || typeof existingFile.sha !== 'string') {
		return 'conflict';
	}
	const filePath = `${folderPath}/${encodeURIComponent(existing.name)}`;
	const response = await fetch(`${repositoryUrl}/contents/${filePath}`, {
		method: 'PUT',
		headers,
		body: JSON.stringify({
			message: `Update reservation for ${object['object type']} ${object['object id']}`,
			content: Buffer.from(JSON.stringify({
				name: object['object name'],
				timestamp: new Date().toISOString(),
				repo: repositoryUrl
			}, null, 4)).toString('base64'),
			sha: existingFile.sha,
			branch: RANGE_BRANCH
		})
	});
	if (response.status === 409 || response.status === 422) {
		return 'conflict';
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
			await ensureRangeRepository(
				matchingRemoteOwner, accountLogin, headers, organizationUsageProvider, debugProvider,
				rangeDiagnostics, manualRangeUpdate, extensionUsageProvider
			);
			return;
		}

		if (organizations.length === 0) {
			await saveRepositoryOwner(accountLogin, session.account.id, 'default');
			await ensureRangeRepository(
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
			await saveRepositoryOwner(selection.owner, session.account.id, 'user');
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
	const applicationRegistration = appManifest
		? createApplicationRegistration(appManifest.manifest)
		: undefined;
	if (appManifest && applicationRegistration) {
		const registration = applicationRegistration;
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
		const repositoryRegistration = rangeData.ranges.find((item) => item.id === applicationRegistration.id);
		if (repositoryRegistration && !areRangesEqual(applicationRegistration.ranges, repositoryRegistration.ranges)) {
			const promptKey = `${owner}:${applicationRegistration.id}:${JSON.stringify(applicationRegistration.ranges)}:${JSON.stringify(repositoryRegistration.ranges)}`;
			if (!promptedRangeMismatches.has(promptKey)) {
				promptedRangeMismatches.add(promptKey);
				const useRepositoryRange = 'Update app.json from data.json';
				const keepApplicationRange = 'Keep app.json range';
				const selection = await vscode.window.showWarningMessage(
					`The ${RANGE_FILE_NAME} range for ${applicationRegistration.name} differs from app.json. Use the upstream range in app.json?`,
					useRepositoryRange,
					keepApplicationRange
				);
				if (selection === useRepositoryRange) {
					await updateApplicationManifestRanges(appManifest, repositoryRegistration.ranges);
					applicationRegistration.ranges = repositoryRegistration.ranges;
					appManifest.manifest.idRanges = repositoryRegistration.ranges;
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

	organizationUsageProvider?.setRangeData(owner, rangeData, applicationRegistration);
	debugProvider?.setRemarks(rangeData.Remarks);
}

/**
 * @param {string} owner
 * @param {RangeRegistration} registration
 * @param {GitHubApiHeaders} headers
 */
async function forceApplicationRangeToRepositoryData(owner, registration, headers) {
	const repositoryUrl = `${GITHUB_API_URL}/repos/${encodeURIComponent(owner)}/${RANGE_REPOSITORY_NAME}`;
	const contentsUrl = `${repositoryUrl}/contents/${encodeURIComponent(RANGE_FILE_NAME)}`;
	const latestResponse = await fetch(`${contentsUrl}?ref=${encodeURIComponent(RANGE_BRANCH)}`, { headers });
	if (!latestResponse.ok) {
		throw new Error(await getGithubResponseError(latestResponse));
	}
	const latestFile = /** @type {GitHubContentsFile} */ (await latestResponse.json());
	const latestData = parseRangeData(latestFile);
	const registrationIndex = latestData.ranges.findIndex((item) => item.id === registration.id);
	if (registrationIndex < 0) {
		throw new Error(`The application is no longer registered in ${RANGE_FILE_NAME}. Refresh organization usage and try again.`);
	}
	if (areRangesEqual(latestData.ranges[registrationIndex].ranges, registration.ranges)) {
		return false;
	}

	latestData.ranges[registrationIndex] = {
		...latestData.ranges[registrationIndex],
		ranges: registration.ranges
	};
	const updateResponse = await fetch(contentsUrl, {
		method: 'PUT',
		headers,
		body: JSON.stringify({
			message: `Update ${registration.name} application range`,
			content: Buffer.from(JSON.stringify(latestData, null, 4)).toString('base64'),
			sha: latestFile.sha,
			branch: RANGE_BRANCH
		})
	});
	if (!updateResponse.ok) {
		throw new Error(await getGithubResponseError(updateResponse));
	}
	return true;
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

/** @param {{ uri: vscode.Uri, manifest: Record<string, any> }} appManifest @param {Array<{ from: number, to: number }>} ranges */
async function updateApplicationManifestRanges(appManifest, ranges) {
	const content = await vscode.workspace.fs.readFile(appManifest.uri);
	const currentManifest = JSON.parse(Buffer.from(content).toString('utf8'));
	if (currentManifest.id !== appManifest.manifest.id) {
		throw new Error('The application manifest changed before its range could be updated.');
	}
	currentManifest.idRanges = ranges;
	await vscode.workspace.fs.writeFile(
		appManifest.uri,
		Buffer.from(JSON.stringify(currentManifest, null, 4))
	);
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
	createApplicationRegistration,
	areRangesEqual,
	forceApplicationRangeToRepositoryData,
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

const vscode = require('vscode');
const EXTENSION_CONFIG = require('./config.json');
const { getExtensionObjectKey, isObjectIdInRanges, areRangesEqual } = require('./object-model');

const RANGE_REPOSITORY_NAME = EXTENSION_CONFIG.rangeRepository.name;
const RANGE_REPOSITORY_DISPLAY_NAME = EXTENSION_CONFIG.rangeRepository.displayName;
const RANGE_FILE_NAME = EXTENSION_CONFIG.rangeRepository.fileName;
const RANGE_BRANCH = EXTENSION_CONFIG.rangeRepository.branch;

/** @typedef {{ 'object type': string, 'object name': string, 'object id': string }} ExtensionObject */
/** @typedef {'outOfRange' | 'conflict' | 'synced' | 'unsynced' | 'checking' | 'unavailable'} ObjectSyncStatus */
/** @typedef {ExtensionObject & { syncStatus: ObjectSyncStatus }} ExtensionUsageEntry */
/** @typedef {{ label: string, description?: string, isSelected?: boolean, syncStatus?: ObjectSyncStatus, contextValue?: string, object?: ExtensionUsageEntry, command?: string, children?: DebugTreeItem[] }} DebugTreeItem */
/** @typedef {{ login: string }} GitHubUser */
/** @typedef {{ login: string }} GitHubOrganization */
/** @typedef {Record<string, string>} GitHubApiHeaders */

/** @typedef {{
 * hasAlWorkspace: () => Promise<boolean>,
 * getGithubHeaders: (session: vscode.AuthenticationSession) => GitHubApiHeaders,
 * getGithubJson: (url: string, headers: GitHubApiHeaders) => Promise<any>,
 * getGithubOrganizations: (headers: GitHubApiHeaders) => Promise<GitHubOrganization[]>,
 * providerId: string,
 * scopes: readonly string[],
 * repositoryOwnerSetting: string,
 * repositoryAccountSetting: string
 * }} GithubDebugDependencies */

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

	/** @param {DebugTreeItem} item @returns {vscode.TreeItem} */
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

	/** @param {DebugTreeItem} [element] @returns {Promise<DebugTreeItem[]>} */
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
	/** @param {() => Promise<boolean>} hasAlWorkspace */
	constructor(hasAlWorkspace) {
		super([{ label: 'Waiting for GitHub account selection.' }]);
		this.hasAlWorkspace = hasAlWorkspace;
		/** @type {string | undefined} */
		this.syncingRangeKey = undefined;
		/** @type {string | undefined} */
		this.rangeOwner = undefined;
		/** @type {{ Remarks: string[], ranges: Array<{ id: string, name: string, publisher: string, ranges: Array<{ from: number, to: number }> }> } | undefined} */
		this.rangeData = undefined;
		/** @type {{ id: string, ranges: Array<{ from: number, to: number }> } | undefined} */
		this.applicationRegistration = undefined;
	}

	/** @param {string} owner @param {string} applicationId @param {boolean} syncing */
	setRangeSyncing(owner, applicationId, syncing) {
		this.syncingRangeKey = syncing ? `${owner}:${applicationId}` : undefined;
		if (this.rangeOwner && this.rangeData) {
			this.setRangeData(this.rangeOwner, this.rangeData, this.applicationRegistration);
		} else {
			this.refresh();
		}
	}

	/** @param {string} message */
	setStatus(message) {
		this.items = [{ label: message }];
		this.refresh();
	}

	/** @param {string} owner @param {{ Remarks: string[], ranges: Array<{ id: string, name: string, publisher: string, ranges: Array<{ from: number, to: number }> }> }} rangeData @param {{ id: string, ranges: Array<{ from: number, to: number }> } | undefined} applicationRegistration */
	setRangeData(owner, rangeData, applicationRegistration) {
		this.rangeOwner = owner;
		this.rangeData = rangeData;
		this.applicationRegistration = applicationRegistration;
		this.items = [{
			label: RANGE_FILE_NAME,
			description: `${owner}/${RANGE_REPOSITORY_NAME} (${RANGE_BRANCH})`,
			children: rangeData.ranges.map((registration) => {
				const isCurrentApplication = applicationRegistration?.id === registration.id;
				const rangeMismatch = isCurrentApplication &&
					!areRangesEqual(applicationRegistration.ranges, registration.ranges);
				const isSyncing = this.syncingRangeKey === `${owner}:${registration.id}`;
				if (isCurrentApplication) {
					const contextValue = rangeMismatch
						? isSyncing ? 'forcingApplicationRange' : 'mismatchedApplicationRange'
						: undefined;
					const applicationRanges = applicationRegistration.ranges.length > 0
						? applicationRegistration.ranges.map((range) => ({
							label: `app.json: ${range.from}-${range.to}`,
							syncStatus: rangeMismatch ? 'outOfRange' : 'synced',
							contextValue,
							rangeOwner: owner,
							applicationId: registration.id
						}))
						: [{
							label: 'app.json: no ranges',
							syncStatus: rangeMismatch ? 'outOfRange' : 'synced',
							contextValue,
							rangeOwner: owner,
							applicationId: registration.id
						}];
					return {
						label: `${registration.name} (${registration.publisher})`,
						description: registration.id,
						children: rangeMismatch
							? [
								...applicationRanges,
								...registration.ranges.map((range) => ({ label: `data.json: ${range.from}-${range.to}` }))
							]
							: applicationRanges
					};
				}
				return {
					label: `${registration.name} (${registration.publisher})`,
					description: registration.id,
					children: registration.ranges.map((range) => ({ label: `${range.from}-${range.to}` }))
				};
			})
		}];
		this.refresh();
	}

	/** @param {DebugTreeItem} [element] @returns {Promise<DebugTreeItem[]>} */
	async getChildren(element) {
		if (!element && !await this.hasAlWorkspace()) {
			return [{ label: 'Open a valid AL workspace to load organization usage.' }];
		}
		return super.getChildren(element);
	}
}

class GithubDebugDataProvider extends TreeDataProvider {
	/** @param {GithubDebugDependencies} dependencies */
	constructor(dependencies) {
		super();
		this.dependencies = dependencies;
		/** @type {string[]} */
		this.remarks = [];
	}

	/** @param {string[]} remarks */
	setRemarks(remarks) {
		this.remarks = remarks;
		this.refresh();
	}

	/** @param {DebugTreeItem} [element] @returns {Promise<DebugTreeItem[]>} */
	async getChildren(element) {
		if (element) {
			return element.children || [];
		}
		if (!await this.dependencies.hasAlWorkspace()) {
			return [{ label: 'Open a valid AL workspace to inspect GitHub accounts.' }];
		}

		try {
			const [accounts, session] = await Promise.all([
				vscode.authentication.getAccounts(this.dependencies.providerId),
				vscode.authentication.getSession(this.dependencies.providerId, this.dependencies.scopes, { silent: true })
			]);
			const accountItems = accounts.length > 0
				? accounts.map((account) => ({
					label: account.label,
					description: session?.account.id === account.id ? 'Selected GitHub account' : undefined,
					isSelected: session?.account.id === account.id
				}))
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
		const headers = this.dependencies.getGithubHeaders(session);
		const user = /** @type {GitHubUser} */ (
			await this.dependencies.getGithubJson(`${EXTENSION_CONFIG.github.apiUrl}/user`, headers)
		);
		const organizations = await this.dependencies.getGithubOrganizations(headers);
		const configuration = vscode.workspace.getConfiguration('object-manager');
		const selectedOwner = configuration.get(this.dependencies.repositoryOwnerSetting);
		const selectedAccountId = configuration.get(this.dependencies.repositoryAccountSetting);
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

module.exports = {
	TreeDataProvider,
	ExtensionUsageDataProvider,
	OrganizationUsageDataProvider,
	GithubDebugDataProvider
};
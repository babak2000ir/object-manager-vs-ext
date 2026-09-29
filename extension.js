// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const EXTENSION_CONFIG = require('./config.json');

const GITHUB_AUTH_PROVIDER = EXTENSION_CONFIG.github.providerId;
const GITHUB_AUTH_SCOPES = EXTENSION_CONFIG.github.scopes;
const GITHUB_API_URL = EXTENSION_CONFIG.github.apiUrl;
const RANGE_REPOSITORY_NAME = EXTENSION_CONFIG.rangeRepository.name;
const RANGE_FILE_NAME = EXTENSION_CONFIG.rangeRepository.fileName;
const RANGE_BRANCH = EXTENSION_CONFIG.rangeRepository.branch;
const INITIAL_RANGE_DATA = EXTENSION_CONFIG.rangeRepository.initialData;
const REPOSITORY_OWNER_SETTING = 'repositoryOwner';
const REPOSITORY_ACCOUNT_SETTING = 'repositoryAccountId';

/** @typedef {{ login: string }} GitHubUser */
/** @typedef {{ login: string }} GitHubOrganization */
/** @typedef {{ default_branch: string }} GitHubRepository */
/** @typedef {{ content: string }} GitHubContentsFile */
/** @typedef {{ object: { sha: string } }} GitHubReference */
/** @typedef {{ id: string, name: string, publisher: string, ranges: Array<{ from: number, to: number }> }} RangeRegistration */
/** @typedef {{ Remarks: string[], ranges: RangeRegistration[] }} RangeData */
/** @typedef {Record<string, string>} GitHubApiHeaders */
/** @typedef {{ label: string, description?: string, isSelected?: boolean, command?: string, children?: DebugTreeItem[] }} DebugTreeItem */

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "object-manager" is now active!');
	const debugProvider = new GithubDebugDataProvider();
	const organizationUsageProvider = new OrganizationUsageDataProvider();
	let workspaceWasOpen = hasWorkspace();
	if (workspaceWasOpen) {
		void configureGithubRepositoryOwner(false, debugProvider, organizationUsageProvider);
	}
	const workspaceChangeListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
		const workspaceIsOpen = hasWorkspace();
		if (!workspaceWasOpen && workspaceIsOpen) {
			void configureGithubRepositoryOwner(false, debugProvider, organizationUsageProvider);
		}
		workspaceWasOpen = workspaceIsOpen;
		debugProvider.refresh();
	});
	const authenticationChangeListener = vscode.authentication.onDidChangeSessions((event) => {
		if (event.provider.id === GITHUB_AUTH_PROVIDER) {
			debugProvider.refresh();
		}
	});
	const configurationChangeListener = vscode.workspace.onDidChangeConfiguration((event) => {
		if (
			event.affectsConfiguration(`object-manager.${REPOSITORY_OWNER_SETTING}`) ||
			event.affectsConfiguration(`object-manager.${REPOSITORY_ACCOUNT_SETTING}`)
		) {
			debugProvider.refresh();
		}
	});

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
		() => configureGithubRepositoryOwner(true, debugProvider, organizationUsageProvider)
	);

	context.subscriptions.push(
		disposable,
		manageAccountPreference,
		workspaceChangeListener,
		authenticationChangeListener,
		configurationChangeListener,
		vscode.window.registerTreeDataProvider('object-manager.commands', new TreeDataProvider([
			{ label: 'Hello World', command: 'object-manager.helloWorld' }
		])),
		vscode.window.registerTreeDataProvider('object-manager.extensionUsage', new TreeDataProvider([
			{ label: 'Usage data is not configured.' }
		])),
		vscode.window.registerTreeDataProvider('object-manager.organizationUsage', organizationUsageProvider),
		vscode.window.registerTreeDataProvider('object-manager.debug', debugProvider)
	);
}

function hasWorkspace() {
	return Boolean(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length);
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
		Accept: 'application/vnd.github+json',
		Authorization: `Bearer ${session.accessToken}`,
		'X-GitHub-Api-Version': '2022-11-28'
	};
}

/**
 * @param {GithubDebugDataProvider} [debugProvider]
 * @param {OrganizationUsageDataProvider} [organizationUsageProvider]
 */
async function configureGithubRepositoryOwner(showAccountPicker = false, debugProvider, organizationUsageProvider) {
	if (!hasWorkspace()) {
		if (showAccountPicker) {
			vscode.window.showInformationMessage('Open a folder or workspace before configuring a GitHub account.');
		}
		debugProvider?.refresh();
		organizationUsageProvider?.setStatus('Open a workspace to load organization usage.');
		return;
	}
	organizationUsageProvider?.setStatus(`Checking ${RANGE_REPOSITORY_NAME}/${RANGE_FILE_NAME}...`);
	debugProvider?.setRemarks([]);

	try {
		const session = await selectGithubAccount(showAccountPicker);
		if (!session) {
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
			await ensureRangeRepository(accountLogin, accountLogin, headers, organizationUsageProvider, debugProvider);
			return;
		}

		if (!showAccountPicker && !accountChanged && typeof configuredOwner === 'string' && validOwners.includes(configuredOwner)) {
			await ensureRangeRepository(configuredOwner, accountLogin, headers, organizationUsageProvider, debugProvider);
			return;
		}

		const choices = [
			{
				label: `${accountLogin} (Personal account)`,
				description: 'Create bc-object-manager under your account',
				owner: accountLogin
			},
			...organizations.map((organization) => ({
				label: `${organization.login} (Organization)`,
				description: 'Create bc-object-manager under this organization',
				owner: organization.login
			}))
		];
		const selection = await vscode.window.showQuickPick(choices, {
			placeHolder: 'Where should bc-object-manager be created?'
		});

		if (selection) {
			await saveRepositoryOwner(selection.owner, session.account.id);
			await ensureRangeRepository(selection.owner, accountLogin, headers, organizationUsageProvider, debugProvider);
		} else {
			organizationUsageProvider?.setStatus(`Select an account or organization to load ${RANGE_FILE_NAME}.`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		organizationUsageProvider?.setStatus(`Unable to load ${RANGE_FILE_NAME}: ${message}`);
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
			`${GITHUB_API_URL}/user/orgs?per_page=100&page=${page}`,
			headers
		));
		organizations.push(...pageOrganizations);
		if (pageOrganizations.length < 100) {
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
 */
async function ensureRangeRepository(owner, accountLogin, headers, organizationUsageProvider, debugProvider) {
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
		repository = await ensureMainBranch(owner, repository, headers);
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
			const fileContent = Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8');
			const parsedRangeData = /** @type {RangeData} */ (JSON.parse(fileContent));
			if (
				!parsedRangeData ||
				!Array.isArray(parsedRangeData.Remarks) ||
				!Array.isArray(parsedRangeData.ranges)
			) {
				throw new Error(`${RANGE_FILE_NAME} must contain Remarks and ranges arrays.`);
			}
			rangeData = parsedRangeData;
		}
	}

	organizationUsageProvider?.setRangeData(owner, rangeData);
	debugProvider?.setRemarks(rangeData.Remarks);
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
		if (item.command) {
			treeItem.command = { command: item.command, title: item.label };
		}
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
		if (!element && !hasWorkspace()) {
			return [{ label: 'Open a workspace to load organization usage.' }];
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
		if (!hasWorkspace()) {
			return [{ label: 'Open a workspace to inspect GitHub accounts.' }];
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
				description: `${owner.type}${selected ? ' selected for bc-object-manager' : ''}`,
				isSelected: selected
			};
		});
	}
}

// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate
}

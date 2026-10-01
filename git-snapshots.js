const path = require('path');
const {
	getExtensionObjectKey,
	getDuplicateObjectKeys,
	isObjectIdInRanges
} = require('./object-model');

/** @typedef {{ 'object type': string, 'object name': string, 'object id': string }} ExtensionObject */

/**
 * @param {{ findFiles: (pattern: string) => PromiseLike<Array<{ toString(): string }>>, readFile: (file: any) => PromiseLike<Uint8Array>, execFileAsync: (command: string, args: string[], options: { cwd: string, maxBuffer?: number }) => Promise<{ stdout: string }>, getGitRepositories: () => PromiseLike<Array<{ rootUri: { fsPath: string } }>>, sourcePattern: string, parseAlObjects: (source: string) => ExtensionObject[] }} dependencies
 */
function createGitSnapshotCollector(dependencies) {
	/** @returns {Promise<ExtensionObject[]>} */
	async function collectExtensionObjects(failOnReadError = false) {
		const files = (await dependencies.findFiles(dependencies.sourcePattern)).sort((left, right) =>
			left.toString().localeCompare(right.toString())
		);
		/** @type {ExtensionObject[]} */
		const objects = [];
		for (const file of files) {
			try {
				const content = await dependencies.readFile(file);
				objects.push(...dependencies.parseAlObjects(Buffer.from(content).toString('utf8')));
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

	/** @param {{ uri: { fsPath: string } }} appManifest */
	async function getApplicationRemoteOwner(appManifest) {
		try {
			const appDirectory = path.dirname(appManifest.uri.fsPath);
			const repositories = (await dependencies.getGitRepositories())
				.filter(({ rootUri }) => isPathWithin(rootUri.fsPath, appDirectory))
				.sort((left, right) => right.rootUri.fsPath.length - left.rootUri.fsPath.length);
			const repository = repositories[0];
			if (!repository) {
				return undefined;
			}
			const { stdout: remoteOutput } = await dependencies.execFileAsync('git', ['remote'], { cwd: repository.rootUri.fsPath });
			const remotes = remoteOutput.split(/\r?\n/).map((remote) => remote.trim()).filter(Boolean);
			const remoteName = remotes.includes('origin') ? 'origin' : remotes[0];
			if (!remoteName) {
				return undefined;
			}
			const { stdout: remoteUrl } = await dependencies.execFileAsync(
				'git', ['remote', 'get-url', remoteName], { cwd: repository.rootUri.fsPath }
			);
			return getGithubOwnerFromRemote(remoteUrl.trim());
		} catch {
			return undefined;
		}
	}

	/** @param {string} rootPath @param {ExtensionObject[]} currentObjects */
	async function collectRepositoryBranchObjects(rootPath, currentObjects) {
		const { stdout: currentBranchOutput } = await dependencies.execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: rootPath });
		const currentBranchName = currentBranchOutput.trim();
		if (!currentBranchName || currentBranchName === 'HEAD') {
			throw new Error('Check out a branch before syncing repository objects.');
		}
		const { stdout: branchOutput } = await dependencies.execFileAsync(
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
			const { stdout: fileOutput } = await dependencies.execFileAsync(
				'git', ['ls-tree', '-r', '-z', '--name-only', branch, '--', '*.al'],
				{ cwd: rootPath, maxBuffer: 50 * 1024 * 1024 }
			);
			const files = fileOutput.split('\0').filter(Boolean);
			const objects = [];
			for (const file of files) {
				const { stdout: source } = await dependencies.execFileAsync(
					'git', ['show', `${branch}:${file}`], { cwd: rootPath, maxBuffer: 50 * 1024 * 1024 }
				);
				objects.push(...dependencies.parseAlObjects(source));
			}
			return { name: branch, isCurrent: false, objects };
		}));
	}

	return { collectExtensionObjects, getApplicationRemoteOwner, collectRepositoryBranchObjects };
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

/** @param {string} parentPath @param {string} childPath */
function isPathWithin(parentPath, childPath) {
	const relativePath = path.relative(parentPath, childPath);
	return relativePath === '' || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath));
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

module.exports = {
	createGitSnapshotCollector,
	getGithubOwnerFromRemote,
	isPathWithin,
	analyzeRepositoryBranchObjects,
	formatBranchConflicts
};
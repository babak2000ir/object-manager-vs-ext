/** @typedef {{ 'object type': string, 'object name': string, 'object id': string }} ExtensionObject */
/** @typedef {'outOfRange' | 'conflict' | 'synced' | 'unsynced' | 'checking' | 'unavailable'} ObjectSyncStatus */

/**
 * @param {{ getApplicationManifest: () => Promise<{ manifest: any } | undefined>, collectExtensionObjects: (failOnReadError?: boolean) => Promise<ExtensionObject[]>, getGithubSession: (silent: boolean) => PromiseLike<any>, getRepositorySelection: () => { owner: unknown, accountId: unknown }, getRepositoryUrl: (owner: string) => string, getGithubHeaders: (session: any) => Record<string, string>, getApplicationObjectStatuses: (repositoryUrl: string, objects: ExtensionObject[], ranges: unknown, headers: Record<string, string>) => Promise<Array<{ object: ExtensionObject, status: ObjectSyncStatus }>>, checkAndUploadApplicationObject: (repositoryUrl: string, object: ExtensionObject, ranges: unknown, headers: Record<string, string>) => Promise<ObjectSyncStatus>, appManifestFileName: string, showErrorMessage: (message: string) => unknown, showInformationMessage: (message: string) => unknown }} dependencies
 */
function createObjectSyncService(dependencies) {
	/** @param {Array<{ object: ExtensionObject, status: ObjectSyncStatus }>} statuses */
	function getObjectValidationFailures(statuses) {
		return statuses.filter(({ status }) => status === 'conflict' || status === 'outOfRange');
	}

	/** @param {any} extensionUsageProvider */
	async function validateWorkspaceObjects(extensionUsageProvider) {
		const appManifest = await dependencies.getApplicationManifest();
		if (!appManifest || !Array.isArray(appManifest.manifest.idRanges)) {
			throw new Error(`Unable to check objects because ${dependencies.appManifestFileName} has no valid idRanges.`);
		}
		const objects = await dependencies.collectExtensionObjects(true);
		extensionUsageProvider.setObjects(objects, appManifest.manifest.idRanges);
		if (objects.length === 0) {
			return { ok: true };
		}
		const session = await dependencies.getGithubSession(true);
		if (!session) {
			extensionUsageProvider.setSyncUnavailable('Sign in to GitHub to validate object reservations before committing or pushing.');
			throw new Error('Sign in to GitHub to validate object reservations before committing or pushing.');
		}
		const { owner, accountId } = dependencies.getRepositorySelection();
		if (typeof owner !== 'string' || !owner || accountId !== session.account.id) {
			extensionUsageProvider.setSyncUnavailable('Choose the GitHub repository owner before validating object reservations.');
			throw new Error('Choose the GitHub repository owner for object validation before committing or pushing.');
		}
		const repositoryUrl = dependencies.getRepositoryUrl(owner);
		let statuses;
		try {
			statuses = await dependencies.getApplicationObjectStatuses(
				repositoryUrl,
				objects,
				appManifest.manifest.idRanges,
				dependencies.getGithubHeaders(session)
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
			dependencies.showErrorMessage(`Git operation blocked. Refresh object data and resolve: ${details}`);
			return { ok: false, message: `Resolve object validation errors: ${details}` };
		}
		return { ok: true };
	}

	/** @param {any} extensionUsageProvider */
	async function syncUnsyncedWorkspaceObjects(extensionUsageProvider) {
		const appManifest = await dependencies.getApplicationManifest();
		if (!appManifest || !Array.isArray(appManifest.manifest.idRanges)) {
			throw new Error(`Unable to sync objects because ${dependencies.appManifestFileName} has no valid idRanges.`);
		}
		const objects = await dependencies.collectExtensionObjects(true);
		extensionUsageProvider.setObjects(objects, appManifest.manifest.idRanges);
		if (objects.length === 0) {
			return 0;
		}
		const session = await dependencies.getGithubSession(true);
		if (!session) {
			throw new Error('Sign in to GitHub to sync object reservations after committing.');
		}
		const { owner, accountId } = dependencies.getRepositorySelection();
		if (typeof owner !== 'string' || !owner || accountId !== session.account.id) {
			throw new Error('Choose the GitHub repository owner to sync object reservations after committing.');
		}
		const repositoryUrl = dependencies.getRepositoryUrl(owner);
		const headers = dependencies.getGithubHeaders(session);
		const statuses = await dependencies.getApplicationObjectStatuses(
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
			dependencies.showInformationMessage(`Synced ${results.synced} object reservation${results.synced === 1 ? '' : 's'} after commit.`);
		}
		if (results.failed > 0) {
			dependencies.showErrorMessage(`Commit succeeded, but ${results.failed} object reservation${results.failed === 1 ? '' : 's'} could not be synced. See the Extension Usage view.`);
		}
		return results.synced;
	}

	/** @param {string} repositoryUrl @param {Array<{ object: ExtensionObject, status: ObjectSyncStatus }>} statuses @param {unknown} ranges @param {Record<string, string>} headers @param {any} extensionUsageProvider */
	async function syncUnsyncedApplicationObjects(repositoryUrl, statuses, ranges, headers, extensionUsageProvider) {
		const unsyncedObjects = statuses.filter(({ status }) => status === 'unsynced');
		let synced = 0;
		let failed = 0;
		for (const { object } of unsyncedObjects) {
			extensionUsageProvider.setObjectSyncing(object, true);
			try {
				const status = await dependencies.checkAndUploadApplicationObject(repositoryUrl, object, ranges, headers);
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

	return { validateWorkspaceObjects, syncUnsyncedWorkspaceObjects, syncUnsyncedApplicationObjects, getObjectValidationFailures };
}

module.exports = { createObjectSyncService };
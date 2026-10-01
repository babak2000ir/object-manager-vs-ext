const {
	isObjectIdInRanges,
	getDuplicateObjectKeys,
	normalizeObjectFilename,
	classifyObjectSyncStatus
} = require('./object-model');

/** @typedef {'outOfRange' | 'conflict' | 'synced' | 'unsynced' | 'checking' | 'unavailable'} ObjectSyncStatus */
/** @typedef {{ 'object type': string, 'object name': string, 'object id': string }} ExtensionObject */

/**
 * @param {{ reservationDirectory: string, branch: string, getGithubJson: (url: string, headers: Record<string, string>) => Promise<any>, getGithubResponseError: (response: Response) => Promise<string>, fetchImpl?: typeof fetch }} dependencies
 * @returns {{ getApplicationObjectStatuses: (repositoryUrl: string, objects: ExtensionObject[], ranges: unknown, headers: Record<string, string>) => Promise<Array<{ object: ExtensionObject, status: ObjectSyncStatus }>>, checkAndUploadApplicationObject: (repositoryUrl: string, object: ExtensionObject, ranges: unknown, headers: Record<string, string>) => Promise<ObjectSyncStatus>, upsertApplicationObjectReservation: (repositoryUrl: string, object: ExtensionObject, ranges: unknown, headers: Record<string, string>) => Promise<ObjectSyncStatus> }}
 */
function createGithubReservationStore(dependencies) {
	const fetchImpl = dependencies.fetchImpl || ((...args) => fetch(...args));

	/** @param {string} repositoryUrl @param {string} objectType @param {Record<string, string>} headers */
	async function getObjectTypeFolderContents(repositoryUrl, objectType, headers) {
		const folderPath = `${dependencies.reservationDirectory}/${encodeURIComponent(objectType)}`;
		const folderUrl = `${repositoryUrl}/contents/${folderPath}?ref=${encodeURIComponent(dependencies.branch)}`;
		const response = await fetchImpl(folderUrl, { headers });
		if (response.status === 404) {
			return [];
		}
		if (!response.ok) {
			throw new Error(await dependencies.getGithubResponseError(response));
		}
		const folderContents = await response.json();
		if (!Array.isArray(folderContents)) {
			throw new Error(`GitHub returned an invalid ${folderPath} directory listing.`);
		}
		return folderContents;
	}

	/** @param {unknown[]} folderContents @param {ExtensionObject} object @param {unknown} ranges @param {Record<string, string>} headers @returns {Promise<ObjectSyncStatus | undefined>} */
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
		const file = await dependencies.getGithubJson(fileEntry.url, headers);
		let remoteRecord;
		try {
			const content = Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8');
			remoteRecord = JSON.parse(content);
		} catch {
			remoteRecord = null;
		}
		return classifyObjectSyncStatus(object, ranges, remoteRecord);
	}

	/** @param {string} repositoryUrl @param {ExtensionObject[]} objects @param {unknown} ranges @param {Record<string, string>} headers @returns {Promise<Array<{ object: ExtensionObject, status: ObjectSyncStatus }>>} */
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

	/** @param {string} repositoryUrl @param {ExtensionObject} object @param {unknown} ranges @param {Record<string, string>} headers @returns {Promise<ObjectSyncStatus>} */
	async function checkAndUploadApplicationObject(repositoryUrl, object, ranges, headers) {
		if (!isObjectIdInRanges(object['object id'], ranges)) {
			return 'outOfRange';
		}
		const objectType = object['object type'].toLowerCase();
		const folderPath = `${dependencies.reservationDirectory}/${encodeURIComponent(objectType)}`;
		const folderUrl = `${repositoryUrl}/contents/${folderPath}?ref=${encodeURIComponent(dependencies.branch)}`;
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
		const response = await fetchImpl(fileUrl, {
			method: 'PUT',
			headers,
			body: JSON.stringify({
				message: `Add reservation for ${object['object type']} ${object['object id']}`,
				content: Buffer.from(JSON.stringify(reservation, null, 4)).toString('base64'),
				branch: dependencies.branch
			})
		});
		if (response.status === 409 || response.status === 422) {
			const latestContents = await dependencies.getGithubJson(folderUrl, headers);
			if (!Array.isArray(latestContents)) {
				throw new Error(`GitHub returned an invalid ${folderPath} directory listing.`);
			}
			return await getReservationFileStatus(latestContents, object, ranges, headers) || 'conflict';
		}
		if (!response.ok) {
			throw new Error(await dependencies.getGithubResponseError(response));
		}
		return 'synced';
	}

	/** @param {string} repositoryUrl @param {ExtensionObject} object @param {unknown} ranges @param {Record<string, string>} headers @returns {Promise<ObjectSyncStatus>} */
	async function upsertApplicationObjectReservation(repositoryUrl, object, ranges, headers) {
		if (!isObjectIdInRanges(object['object id'], ranges)) {
			return 'outOfRange';
		}
		const objectType = object['object type'].toLowerCase();
		const folderPath = `${dependencies.reservationDirectory}/${encodeURIComponent(objectType)}`;
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
		const existingFile = await dependencies.getGithubJson(existing.url, headers);
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
		const response = await fetchImpl(`${repositoryUrl}/contents/${filePath}`, {
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
				branch: dependencies.branch
			})
		});
		if (response.status === 409 || response.status === 422) {
			return 'conflict';
		}
		if (!response.ok) {
			throw new Error(await dependencies.getGithubResponseError(response));
		}
		return 'synced';
	}

	return {
		getApplicationObjectStatuses,
		checkAndUploadApplicationObject,
		upsertApplicationObjectReservation
	};
}

module.exports = { createGithubReservationStore };
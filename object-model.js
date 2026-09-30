/** @typedef {{ 'object type': string, 'object name': string, 'object id': string }} ExtensionObject */
/** @typedef {'outOfRange' | 'conflict' | 'synced' | 'unsynced' | 'checking' | 'unavailable'} ObjectSyncStatus */

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

/** @param {string} objectId @param {unknown} ranges */
function isObjectIdInRanges(objectId, ranges) {
	const numericId = Number(objectId);
	return Number.isFinite(numericId) && Array.isArray(ranges) && ranges.some((range) =>
		range && typeof range === 'object' &&
		typeof range.from === 'number' && typeof range.to === 'number' &&
		numericId >= range.from && numericId <= range.to
	);
}

/** @param {unknown} left @param {unknown} right */
function areRangesEqual(left, right) {
	if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
		return false;
	}
	const sortRanges = (ranges) => [...ranges].sort((first, second) =>
		(first?.from ?? 0) - (second?.from ?? 0) || (first?.to ?? 0) - (second?.to ?? 0)
	);
	const sortedLeft = sortRanges(left);
	const sortedRight = sortRanges(right);
	return sortedLeft.every((range, index) =>
		range?.from === sortedRight[index]?.from && range?.to === sortedRight[index]?.to
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

module.exports = {
	parseAlObjects,
	isObjectIdInRanges,
	areRangesEqual,
	getExtensionObjectKey,
	normalizeObjectFilename,
	classifyObjectSyncStatus
};
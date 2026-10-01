const { areRangesEqual } = require('./object-model');

/** @typedef {{ id: string, name: string, publisher: string, ranges: Array<{ from: number, to: number }> }} RangeRegistration */
/** @typedef {{ Remarks: string[], ranges: RangeRegistration[] }} RangeData */
/** @typedef {{ content: string, sha: string }} GitHubContentsFile */
/** @typedef {{ default_branch: string }} GitHubRepository */
/** @typedef {{ object: { sha: string } }} GitHubReference */
/** @typedef {{ 'object type': string, 'object name': string, 'object id': string }} ExtensionObject */
/** @typedef {'outOfRange' | 'conflict' | 'synced' | 'unsynced' | 'checking' | 'unavailable'} ObjectSyncStatus */

/**
 * @param {{ vscode: typeof import('vscode'), apiUrl: string, repositoryName: string, fileName: string, branch: string, initialData: RangeData, getGithubJson: (url: string, headers: Record<string, string>, requestOptions?: RequestInit) => Promise<any>, getGithubResponseError: (response: Response) => Promise<string>, getApplicationManifest: () => Promise<{ uri: import('vscode').Uri, manifest: Record<string, any> } | undefined>, collectExtensionObjects: () => Promise<ExtensionObject[]>, getApplicationObjectStatuses: (repositoryUrl: string, objects: ExtensionObject[], ranges: unknown, headers: Record<string, string>) => Promise<Array<{ object: ExtensionObject, status: ObjectSyncStatus }>> }} dependencies
 */
function createGithubRangeRepository(dependencies) {
	const promptedRangeMismatches = new Set();
	const { vscode } = dependencies;

	/** @param {GitHubContentsFile} file @returns {RangeData} */
	function parseRangeData(file) {
		const fileContent = Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8');
		const parsedRangeData = /** @type {RangeData} */ (JSON.parse(fileContent));
		if (
			!parsedRangeData ||
			!Array.isArray(parsedRangeData.Remarks) ||
			!Array.isArray(parsedRangeData.ranges)
		) {
			throw new Error(`${dependencies.fileName} must contain Remarks and ranges arrays.`);
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

	/** @param {{ uri: import('vscode').Uri, manifest: Record<string, any> }} appManifest @param {Array<{ from: number, to: number }>} ranges */
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

	/** @param {import('vscode').DiagnosticCollection | undefined} diagnostics @param {import('vscode').Uri} uri */
	function setMissingRangeDiagnostic(diagnostics, uri) {
		if (!diagnostics) {
			return;
		}
		const diagnostic = new vscode.Diagnostic(
			new vscode.Range(0, 0, 0, 0),
			`Application range is missing from ${dependencies.fileName}. Run "Create/Update Application Range" to add it.`,
			vscode.DiagnosticSeverity.Error
		);
		diagnostic.source = 'BC Object Manager';
		diagnostics.set(uri, [diagnostic]);
	}

	/** @param {string} owner @param {GitHubRepository} repository @param {Record<string, string>} headers @returns {Promise<GitHubRepository>} */
	async function ensureMainBranch(owner, repository, headers) {
		if (repository.default_branch === dependencies.branch) {
			return repository;
		}
		const repositoryPath = `/repos/${encodeURIComponent(owner)}/${dependencies.repositoryName}`;
		const sourceReference = /** @type {GitHubReference} */ (await dependencies.getGithubJson(
			`${dependencies.apiUrl}${repositoryPath}/git/ref/heads/${encodeURIComponent(repository.default_branch)}`,
			headers
		));
		await dependencies.getGithubJson(`${dependencies.apiUrl}${repositoryPath}/git/refs`, headers, {
			method: 'POST',
			body: JSON.stringify({ ref: `refs/heads/${dependencies.branch}`, sha: sourceReference.object.sha })
		});
		return /** @type {GitHubRepository} */ (await dependencies.getGithubJson(
			`${dependencies.apiUrl}${repositoryPath}`,
			headers,
			{ method: 'PATCH', body: JSON.stringify({ default_branch: dependencies.branch }) }
		));
	}

	/** @param {string} repositoryUrl @param {Record<string, string>} headers */
	async function createRangeFile(repositoryUrl, headers) {
		await dependencies.getGithubJson(`${repositoryUrl}/contents/${encodeURIComponent(dependencies.fileName)}`, headers, {
			method: 'PUT',
			body: JSON.stringify({
				message: `Add initial ${dependencies.fileName}`,
				content: Buffer.from(JSON.stringify(dependencies.initialData, null, 4)).toString('base64'),
				branch: dependencies.branch
			})
		});
	}

	/** @param {string} owner @param {RangeRegistration} registration @param {Record<string, string>} headers */
	async function forceApplicationRangeToRepositoryData(owner, registration, headers) {
		const repositoryUrl = `${dependencies.apiUrl}/repos/${encodeURIComponent(owner)}/${dependencies.repositoryName}`;
		const contentsUrl = `${repositoryUrl}/contents/${encodeURIComponent(dependencies.fileName)}`;
		const latestResponse = await fetch(`${contentsUrl}?ref=${encodeURIComponent(dependencies.branch)}`, { headers });
		if (!latestResponse.ok) {
			throw new Error(await dependencies.getGithubResponseError(latestResponse));
		}
		const latestFile = /** @type {GitHubContentsFile} */ (await latestResponse.json());
		const latestData = parseRangeData(latestFile);
		const registrationIndex = latestData.ranges.findIndex((item) => item.id === registration.id);
		if (registrationIndex < 0) {
			throw new Error(`The application is no longer registered in ${dependencies.fileName}. Refresh organization usage and try again.`);
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
				branch: dependencies.branch
			})
		});
		if (!updateResponse.ok) {
			throw new Error(await dependencies.getGithubResponseError(updateResponse));
		}
		return true;
	}

	/** @param {string} owner @param {string} accountLogin @param {Record<string, string>} headers @param {any} organizationUsageProvider @param {any} debugProvider @param {import('vscode').DiagnosticCollection | undefined} rangeDiagnostics @param {boolean} manualRangeUpdate @param {any} extensionUsageProvider */
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
		const repositoryPath = `/repos/${encodeURIComponent(owner)}/${dependencies.repositoryName}`;
		const repositoryUrl = `${dependencies.apiUrl}${repositoryPath}`;
		const repositoryResponse = await fetch(repositoryUrl, { headers });
		let rangeData;

		if (repositoryResponse.status === 404) {
			const createUrl = owner === accountLogin
				? `${dependencies.apiUrl}/user/repos`
				: `${dependencies.apiUrl}/orgs/${encodeURIComponent(owner)}/repos`;
			const repository = /** @type {GitHubRepository} */ (await dependencies.getGithubJson(
				createUrl,
				headers,
				{
					method: 'POST',
					body: JSON.stringify({
						name: dependencies.repositoryName,
						private: true,
						auto_init: true
					})
				}
			));
			await ensureMainBranch(owner, repository, headers);
			await createRangeFile(repositoryUrl, headers);
			rangeData = dependencies.initialData;
		} else {
			if (!repositoryResponse.ok) {
				throw new Error(await dependencies.getGithubResponseError(repositoryResponse));
			}
			const contentsUrl = `${repositoryUrl}/contents/${encodeURIComponent(dependencies.fileName)}?ref=${encodeURIComponent(dependencies.branch)}`;
			const contentsResponse = await fetch(contentsUrl, { headers });
			if (contentsResponse.status === 404) {
				await createRangeFile(repositoryUrl, headers);
				rangeData = dependencies.initialData;
			} else {
				if (!contentsResponse.ok) {
					throw new Error(await dependencies.getGithubResponseError(contentsResponse));
				}
				const file = /** @type {GitHubContentsFile} */ (await contentsResponse.json());
				rangeData = parseRangeData(file);
			}
		}

		const appManifest = await dependencies.getApplicationManifest();
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
				const contentsUrl = `${repositoryUrl}/contents/${encodeURIComponent(dependencies.fileName)}`;
				const latestResponse = await fetch(`${contentsUrl}?ref=${encodeURIComponent(dependencies.branch)}`, { headers });
				if (!latestResponse.ok) {
					throw new Error(await dependencies.getGithubResponseError(latestResponse));
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
							branch: dependencies.branch
						})
					});
					if (updateResponse.status === 409 || updateResponse.status === 422) {
						const refreshedResponse = await fetch(`${contentsUrl}?ref=${encodeURIComponent(dependencies.branch)}`, { headers });
						let refreshError;
						if (refreshedResponse.ok) {
							rangeData = parseRangeData(/** @type {GitHubContentsFile} */ (await refreshedResponse.json()));
						} else {
							refreshError = await dependencies.getGithubResponseError(refreshedResponse);
						}
						if (rangeData.ranges.some((item) => item.id === registration.id)) {
							rangeDiagnostics?.delete(appManifest.uri);
						} else {
							setMissingRangeDiagnostic(rangeDiagnostics, appManifest.uri);
						}
						const action = 'Create/Update Application Range';
						const selection = await vscode.window.showErrorMessage(
							refreshError
								? `The range data changed while saving. Unable to reload ${dependencies.fileName}: ${refreshError}. Run ${action} to try again.`
								: `The range data changed while saving. ${dependencies.fileName} was downloaded again. Run ${action} to try again.`,
							action
						);
						if (selection === action) {
							void vscode.commands.executeCommand('object-manager.createUpdateApplicationRange');
						}
					} else if (!updateResponse.ok) {
						throw new Error(await dependencies.getGithubResponseError(updateResponse));
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
						`The ${dependencies.fileName} range for ${applicationRegistration.name} differs from app.json. Use the upstream range in app.json?`,
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
			const localObjects = extensionUsageProvider?.getObjects() || await dependencies.collectExtensionObjects();
			const syncStatuses = await dependencies.getApplicationObjectStatuses(
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

	return {
		ensureRangeRepository,
		forceApplicationRangeToRepositoryData,
		parseRangeData,
		createApplicationRegistration
	};
}

module.exports = { createGithubRangeRepository };
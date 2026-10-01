const crypto = require('crypto');
const http = require('http');
const path = require('path');

/**
 * @param {{ execFileAsync: (command: string, args: string[], options: { cwd: string }) => Promise<{ stdout: string }>, fileSystem: typeof import('fs/promises'), hookSourcePath: string, hookNames: string[], marker: string }} dependencies
 */
function createGitValidationTools(dependencies) {
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

	/** @param {{ rootUri: { fsPath: string } }} repository */
	async function prepareGitHookInstallation(repository) {
		const rootPath = repository.rootUri.fsPath;
		const { stdout: configuredHooksPath } = await dependencies.execFileAsync(
			'git', ['config', '--get', 'core.hooksPath'], { cwd: rootPath }
		).catch((error) => {
			if (error.code === 1) {
				return { stdout: '' };
			}
			throw error;
		});
		if (configuredHooksPath.trim()) {
			throw new Error(`A custom core.hooksPath is configured for ${rootPath}; refusing to change it.`);
		}
		const { stdout: hooksPath } = await dependencies.execFileAsync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: rootPath });
		const hooksDirectory = path.resolve(rootPath, hooksPath.trim());
		const validationConfigPath = path.resolve(hooksDirectory, '..', 'object-manager-validation.json');
		for (const hookName of dependencies.hookNames) {
			const hookPath = path.join(hooksDirectory, hookName);
			try {
				const existingHook = await dependencies.fileSystem.readFile(hookPath, 'utf8');
				if (!existingHook.includes(dependencies.marker)) {
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
		const hookSource = await dependencies.fileSystem.readFile(dependencies.hookSourcePath);
		await dependencies.fileSystem.mkdir(installation.hooksDirectory, { recursive: true });
		for (const hookName of dependencies.hookNames) {
			const hookPath = path.join(installation.hooksDirectory, hookName);
			await dependencies.fileSystem.writeFile(hookPath, hookSource);
			await dependencies.fileSystem.chmod(hookPath, 0o755);
		}
		await dependencies.fileSystem.writeFile(installation.validationConfigPath, JSON.stringify(server));
	}

	/** @param {{ rootUri: { fsPath: string } }} repository */
	async function removeGitValidationHooksForRepository(repository) {
		const installation = await prepareGitHookInstallation(repository);
		for (const hookName of dependencies.hookNames) {
			const hookPath = path.join(installation.hooksDirectory, hookName);
			try {
				const existingHook = await dependencies.fileSystem.readFile(hookPath, 'utf8');
				if (existingHook.includes(dependencies.marker)) {
					await dependencies.fileSystem.rm(hookPath);
				}
			} catch (error) {
				if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
					throw error;
				}
			}
		}
		await dependencies.fileSystem.rm(installation.validationConfigPath, { force: true });
	}

	return {
		startValidationServer,
		prepareGitHookInstallation,
		installGitValidationHooksForRepository,
		removeGitValidationHooksForRepository
	};
}

module.exports = { createGitValidationTools };
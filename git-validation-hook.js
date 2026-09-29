#!/usr/bin/env node
// object-manager-validation-hook
const fs = require('fs/promises');
const http = require('http');
const path = require('path');

async function runValidationHook() {
	const configPath = path.resolve(__dirname, '..', 'object-manager-validation.json');
	const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
	/** @type {Promise<void>} */
	const validationPromise = new Promise((resolve, reject) => {
		const request = http.request(config.url, {
			method: 'POST',
			headers: { Authorization: `Bearer ${config.token}` },
			timeout: 120000
		}, (response) => {
			let responseBody = '';
			response.setEncoding('utf8');
			response.on('data', (chunk) => { responseBody += chunk; });
			response.on('end', () => {
				const statusCode = response.statusCode || 0;
				let result;
				try {
					result = JSON.parse(responseBody);
				} catch {
					reject(new Error(`Validation server returned HTTP ${statusCode}.`));
					return;
				}
				if (statusCode < 200 || statusCode >= 300 || !result.ok) {
					reject(new Error(result.message || `Validation server returned HTTP ${statusCode}.`));
					return;
				}
				resolve(undefined);
			});
	});
		request.on('timeout', () => request.destroy(new Error('Object validation timed out.')));
		request.on('error', reject);
		request.end();
	});
	await validationPromise;
}

runValidationHook().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Object Manager blocked the Git operation: ${message}`);
	process.exitCode = 1;
});
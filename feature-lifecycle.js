/**
 * @param {Array<(listener: () => void) => { dispose(): void }>} triggers
 * @param {() => Promise<boolean>} isEnabled
 * @param {() => void} start
 * @param {() => void} stop
 */
function activateOnTriggers(triggers, isEnabled, start, stop) {
	/** @type {{ dispose(): void }[]} */
	const triggerDisposables = [];
	let active = false;
	let disposed = false;
	let checkId = 0;

	const update = async () => {
		const currentCheckId = ++checkId;
		const shouldBeActive = await isEnabled();
		if (disposed || currentCheckId !== checkId || shouldBeActive === active) {
			return;
		}
		active = shouldBeActive;
		if (active) {
			start();
		} else {
			stop();
		}
	};

	for (const registerTrigger of triggers) {
		triggerDisposables.push(registerTrigger(() => void update()));
	}
	void update();

	return {
		dispose() {
			disposed = true;
			checkId++;
			for (const disposable of triggerDisposables.splice(0)) {
				disposable.dispose();
			}
			if (active) {
				active = false;
				stop();
			}
		}
	};
}

module.exports = { activateOnTriggers };
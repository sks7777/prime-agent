/**
 * Abortable sleep shared by the OAuth device/poll login flows: resolves after
 * `ms`, rejects with the cancelled error if the signal aborts first, and
 * detaches the listener once the sleep completes.
 */
export function abortableSleep(ms: number, signal?: AbortSignal, cancelledMessage = "Login cancelled"): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error(cancelledMessage));
			return;
		}

		let timeout: NodeJS.Timeout;
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error(cancelledMessage));
		};
		timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

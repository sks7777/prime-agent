import { Buffer } from "node:buffer";

/**
 * Shared catalog HTTP response policy: reject error statuses, enforce the
 * content-length cap up front, then stream the body under the same byte cap
 * (a lying content-length cannot over-read) and parse JSON.
 */
export interface BoundedJsonResponseOptions {
	maxBytes: number;
	statusError: (status: number) => Error;
	tooLargeError: () => Error;
	emptyError: () => Error;
}

export async function readBoundedJsonResponse(
	response: Response,
	options: BoundedJsonResponseOptions,
): Promise<unknown> {
	const { maxBytes, statusError, tooLargeError, emptyError } = options;
	if (!response.ok) throw statusError(response.status);
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > maxBytes) throw tooLargeError();
	if (!response.body) throw emptyError();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				await reader.cancel().catch(() => {});
				throw tooLargeError();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
}

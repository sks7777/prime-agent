import type { Entry } from "../harness/session/types.js";

export type {
	ScanningReadable,
	ScanningReadableOptions,
	ScanningReadableSource,
	ScanningSearchTextProjector,
	ScanningSessionSearchHit,
	ScanningSessionSearchOptions,
	SessionSearchCandidate,
} from "./scanning.js";
export { createScanningSessionSearch, scanningEntries } from "./scanning.js";

export interface SessionSearchOptions {
	/** Restrict results to specific canonical entry types. */
	readonly entryTypes?: readonly Entry["type"][];
	/** Maximum number of hits to return. */
	readonly limit?: number;
	/** Abort signal for cancellation, e.g. search-as-you-type. */
	readonly signal?: AbortSignal;
}

export interface SessionSearchHit {
	/** Logical identifier of the session that owns the entry. */
	readonly sessionId: string;
	/** Logical identifier of the entry within that session. */
	readonly entryId: string;
}

export interface SessionSearch<T extends SessionSearchHit = SessionSearchHit> {
	search(text: string, options?: SessionSearchOptions): AsyncIterable<T>;
}

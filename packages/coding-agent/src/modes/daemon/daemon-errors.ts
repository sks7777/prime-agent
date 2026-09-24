import { MissingSessionCwdError } from "../../core/session-cwd.js";
import { SessionImportFileNotFoundError } from "../../core/session-import-errors.js";
import { SessionAlreadyActiveError } from "../../core/session-lease.js";
import type { DaemonErrorInfo, DaemonResponse } from "./daemon-protocol.js";

/**
 * The supervisor is no longer serving commands (shutting down, or it lost its
 * registry ownership). Pre-dispatch by construction: commands carrying this
 * failure never reached a session worker, so replaying them after the daemon
 * restarts is safe. Clients detect this shape and park the request until the
 * replacement supervisor sends its hello.
 */
export class DaemonSupervisorStaleError extends Error {
	readonly code = "supervisor_generation_stale" as const;

	constructor(message: string) {
		super(message);
		this.name = "DaemonSupervisorStaleError";
	}
}

/** A known session (a persisted descriptor names it) that cannot be routed to yet; retryable, unlike "Unknown active session". */
export class DaemonSessionRecoveringError extends Error {
	readonly code = "session_recovering" as const;

	constructor(readonly activeSessionId: string) {
		super(`Active session ${activeSessionId} is recovering; retry shortly`);
		this.name = "DaemonSessionRecoveringError";
	}
}

export function serializeDaemonError(error: unknown): DaemonErrorInfo | undefined {
	if (error instanceof MissingSessionCwdError) {
		return { code: "missing_session_cwd", issue: error.issue };
	}
	if (error instanceof SessionImportFileNotFoundError) {
		return { code: "session_import_file_not_found", filePath: error.filePath };
	}
	if (error instanceof SessionAlreadyActiveError) {
		return {
			code: "session_already_active",
			sessionPath: error.sessionPath,
			activeSessionId: error.activeSessionId,
		};
	}
	if (error instanceof DaemonSessionRecoveringError) {
		return { code: "session_recovering", activeSessionId: error.activeSessionId };
	}
	if (error instanceof DaemonSupervisorStaleError) {
		return { code: "supervisor_generation_stale" };
	}
	return undefined;
}

/** Pre-dispatch supervisor shutdown markers on failures that predate errorInfo. */
export function isSupervisorGenerationStaleMessage(message: string): boolean {
	return message.includes("supervisor generation") && message.includes("shutting down; retry the command");
}

export class DaemonSessionCreateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DaemonSessionCreateError";
	}
}

/** Wraps untyped create failures so the CLI prints one line instead of rethrowing. */
export function deserializeDaemonCreateError(response: Extract<DaemonResponse, { success: false }>): Error {
	const error = deserializeDaemonError(response);
	if (response.errorInfo) return error;
	return new DaemonSessionCreateError(error.message);
}

export function deserializeDaemonError(response: Extract<DaemonResponse, { success: false }>): Error {
	const { errorInfo } = response;
	if (errorInfo?.code === "missing_session_cwd") {
		return new MissingSessionCwdError(errorInfo.issue);
	}
	if (errorInfo?.code === "session_import_file_not_found") {
		return new SessionImportFileNotFoundError(errorInfo.filePath);
	}
	if (errorInfo?.code === "session_already_active") {
		return new SessionAlreadyActiveError(errorInfo.sessionPath, errorInfo.activeSessionId);
	}
	if (errorInfo?.code === "session_recovering") {
		return new DaemonSessionRecoveringError(errorInfo.activeSessionId);
	}
	if (errorInfo?.code === "supervisor_generation_stale") {
		return new DaemonSupervisorStaleError(response.error);
	}
	return new Error(response.error);
}

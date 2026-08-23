import { randomUUID } from "node:crypto";
import type {
	ExtensionCommandContextActions,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.js";
import type { SubagentRuntimeHost } from "../../core/rlm-runtime.js";
import { createAgentConnectionState } from "../agent-connection/snapshot.js";
import type { AgentConnectionState } from "../agent-connection/types.js";
import { type Theme, theme } from "../interactive/theme/theme.js";
import type { ActiveSessionState } from "./active-session-state.js";
import { execEnvForSession, withClientEnv } from "./daemon-client-env.js";
import {
	type DaemonExtensionUIResponse,
	type DaemonOutbound,
	isDaemonDialogExtensionUiRequest,
} from "./daemon-protocol.js";

export interface ActiveSessionBindingCallbacks {
	broadcast: (state: ActiveSessionState, message: DaemonOutbound) => void;
	createConnectionState?: (state: ActiveSessionState) => AgentConnectionState;
	sessionReplaced?: (state: ActiveSessionState) => void;
	shutdown: () => void;
	subagentRuntimeHost?: SubagentRuntimeHost;
}

type BroadcastSessionEvent = Extract<DaemonOutbound, { type: "session_event" }>["event"];

/**
 * message_update events carry the full partial assistant message twice: once
 * as event.message and once nested as assistantMessageEvent.partial. Socket
 * clients read event.message (and assistantMessageEvent.type/toolCall), so the
 * nested copy is dropped before serialization, halving streaming wire bytes
 * per token. In-process consumers (extensions) still receive the full event.
 */
function slimSessionEventForWire(event: BroadcastSessionEvent): BroadcastSessionEvent {
	if (event.type !== "message_update") {
		return event;
	}
	const { partial: _partial, ...assistantMessageEvent } = event.assistantMessageEvent as { partial?: unknown };
	return {
		...event,
		assistantMessageEvent: assistantMessageEvent as typeof event.assistantMessageEvent,
	};
}

export async function bindActiveSessionState(
	state: ActiveSessionState,
	callbacks: ActiveSessionBindingCallbacks,
): Promise<void> {
	const session = state.runtime.session;

	session.setExecEnvProvider(() => execEnvForSession(state.clientEnv));
	// Every runtime rebuild (new/switch/fork/import, subagent spawn) re-loads
	// extensions, which capture client env synchronously at that moment.
	state.runtime.setRuntimeEnvScope((fn) => withClientEnv(state.clientEnv, fn));

	state.unsubscribe?.();
	state.runtime.setSubagentRuntimeHost(callbacks.subagentRuntimeHost);
	state.unsubscribe = session.subscribe((event) => {
		callbacks.broadcast(state, {
			type: "session_event",
			activeSessionId: state.activeSessionId,
			event: slimSessionEventForWire(event),
		});
	});

	state.runtime.setRebindSession(async () => {
		await bindActiveSessionState(state, callbacks);
		callbacks.sessionReplaced?.(state);
		callbacks.broadcast(state, {
			type: "session_replaced",
			activeSessionId: state.activeSessionId,
			state:
				callbacks.createConnectionState?.(state) ??
				createAgentConnectionState(state.runtime, state.activeSessionId),
			messages: state.runtime.session.messages,
		});
	});

	await session.bindExtensions({
		uiContext: createExtensionUIContext(state, callbacks.broadcast),
		commandContextActions: createCommandContextActions(state),
		shutdownHandler: callbacks.shutdown,
		onError: (error) => {
			callbacks.broadcast(state, {
				type: "extension_error",
				activeSessionId: state.activeSessionId,
				extensionPath: error.extensionPath,
				event: error.event,
				error: error.error,
			});
		},
	});
}

function createCommandContextActions(state: ActiveSessionState): ExtensionCommandContextActions {
	return {
		waitForIdle: () => state.runtime.session.waitForIdle(),
		newSession: async (options) => state.runtime.newSession(options),
		fork: async (entryId, options) => {
			const result = await state.runtime.fork(entryId, options);
			return { cancelled: result.cancelled };
		},
		navigateTree: async (targetId, options) => {
			const result = await state.runtime.session.navigateTree(targetId, {
				summarize: options?.summarize,
				customInstructions: options?.customInstructions,
				replaceInstructions: options?.replaceInstructions,
				label: options?.label,
			});
			return { cancelled: result.cancelled };
		},
		switchSession: async (sessionPath, options) => state.runtime.switchSession(sessionPath, options),
		reload: async () => {
			// Reload re-evaluates extension modules, which capture client env
			// (e.g. herdr pane identity) synchronously at load.
			await withClientEnv(state.clientEnv, () => state.runtime.session.reload());
		},
	};
}

function createExtensionUIContext(
	state: ActiveSessionState,
	broadcast: ActiveSessionBindingCallbacks["broadcast"],
): ExtensionUIContext {
	const emitUiRequest = (method: string, payload: Record<string, unknown>): string => {
		const id = randomUUID();
		broadcast(state, {
			type: "extension_ui_request",
			activeSessionId: state.activeSessionId,
			id,
			method,
			payload,
		});
		return id;
	};

	const dialogRequest = <T>(
		method: string,
		payload: Record<string, unknown>,
		opts: ExtensionUIDialogOptions | undefined,
		fallback: T,
		resolveResponse: (response: DaemonExtensionUIResponse) => T,
	): Promise<T> => {
		if (opts?.signal?.aborted) {
			return Promise.resolve(fallback);
		}
		if (!hasExtensionUiClientForMethod(state, method)) {
			return Promise.resolve(fallback);
		}
		const requestId = emitUiRequest(method, payload);
		return new Promise((resolveDialog) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timeoutId) {
					clearTimeout(timeoutId);
				}
				opts?.signal?.removeEventListener("abort", onAbort);
				state.extensionUiRequests.delete(requestId);
			};
			const finish = (value: T) => {
				cleanup();
				resolveDialog(value);
			};
			const onAbort = () => finish(fallback);
			state.extensionUiRequests.set(requestId, {
				resolve: (response) => finish(resolveResponse(response)),
			});
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.timeout !== undefined) {
				timeoutId = setTimeout(() => finish(fallback), opts.timeout);
			}
		});
	};

	return {
		select: (title, values, opts) =>
			dialogRequest("select", { title, options: values, timeout: opts?.timeout }, opts, undefined, (response) =>
				"cancelled" in response && response.cancelled
					? undefined
					: "value" in response
						? response.value
						: undefined,
			),
		confirm: (title, message, opts) =>
			dialogRequest("confirm", { title, message, timeout: opts?.timeout }, opts, false, (response) =>
				"confirmed" in response ? response.confirmed : false,
			),
		input: (title, placeholder, opts) =>
			dialogRequest("input", { title, placeholder, timeout: opts?.timeout }, opts, undefined, (response) =>
				"cancelled" in response && response.cancelled
					? undefined
					: "value" in response
						? response.value
						: undefined,
			),
		notify: (message, notifyType) => emitUiRequest("notify", { message, notifyType }),
		onTerminalInput: () => () => {},
		setStatus: (key, text) => emitUiRequest("setStatus", { statusKey: key, statusText: text }),
		setWorkingMessage: (message) => emitUiRequest("setWorkingMessage", { message }),
		setWorkingVisible: (visible) => emitUiRequest("setWorkingVisible", { visible }),
		setWorkingIndicator: (indicatorOptions?: WorkingIndicatorOptions) =>
			emitUiRequest("setWorkingIndicator", { options: indicatorOptions }),
		setHiddenThinkingLabel: (label) => emitUiRequest("setHiddenThinkingLabel", { label }),
		setWidget: (key: string, content: unknown, widgetOptions?: ExtensionWidgetOptions) => {
			if (content === undefined || Array.isArray(content)) {
				emitUiRequest("setWidget", {
					widgetKey: key,
					widgetLines: content,
					widgetPlacement: widgetOptions?.placement,
				});
			}
		},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: (title) => emitUiRequest("setTitle", { title }),
		async custom<T>(
			factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
			options?: { overlay?: boolean; overlayOptions?: any },
		): Promise<T> {
			if (!hasExtensionUiClientForMethod(state, "custom")) {
				return undefined as T;
			}
			const requestId = randomUUID();
			const widgetKey = `custom:${requestId}`;
			broadcast(state, {
				type: "extension_ui_request",
				activeSessionId: state.activeSessionId,
				id: requestId,
				method: "custom",
				payload: { overlay: options?.overlay ?? false, widgetKey },
			});
			let component: any;
			let closed = false;
			const currentWidth = 120;

			// Proxy TUI: requestRender → re-render component → send via setWidget
			const proxyTui = {
				height: 40,
				requestRender: () => {
					if (closed) return;
					try {
						const lines = component?.render?.(currentWidth) ?? [];
						if (Array.isArray(lines) && lines.length > 0) {
							emitUiRequest("setWidget", { widgetKey, widgetLines: lines, widgetPlacement: "aboveEditor" });
						}
					} catch {
						/* render error */
					}
				},
				setFocus: () => {},
			};

			// Proxy keybindings: match against raw key data
			const proxyKeybindings = {
				matches: (data: string, binding: string) => {
					const defaults: Record<string, string> = {
						"tui.select.up": "\x1b[A",
						"tui.select.down": "\x1b[B",
						"tui.select.confirm": "\r",
						"tui.select.cancel": "\x1b",
						"tui.input.tab": "\t",
						"tui.input.escape": "\x1b",
						"tui.input.enter": "\r",
						"app.clear": "\x03",
					};
					return defaults[binding] !== undefined && data === defaults[binding];
				},
			};

			return new Promise<T>((resolveCustom) => {
				const finish = (result: T) => {
					if (closed) return;
					closed = true;
					emitUiRequest("setWidget", { widgetKey, widgetLines: undefined });
					state.extensionUiRequests.delete(requestId);
					resolveCustom(result);
				};

				// Store handler for key events from client
				state.extensionUiRequests.set(requestId, {
					resolve: (response: any) => {
						if ("key" in response) {
							// Forward key event to component
							if (!closed && component?.handleInput) {
								try {
									component.handleInput(response.key);
								} catch {
									// Extension UI component may throw on unexpected key input
								}
							}
						} else if ("cancelled" in response) {
							finish(undefined as T);
						} else if ("value" in response) {
							finish(response.value as T);
						}
					},
				});

				// Create the component by calling the factory
				Promise.resolve(factory(proxyTui, theme, proxyKeybindings, finish))
					.then((c: any) => {
						if (closed) return;
						component = c;
						// Initial render
						proxyTui.requestRender();
					})
					.catch(() => {
						/* factory error */ finish(undefined as T);
					});
			});
		},
		pasteToEditor: (text) => emitUiRequest("setEditorText", { text }),
		setEditorText: (text) => emitUiRequest("setEditorText", { text }),
		getEditorText: () => "",
		editor: (title, prefill) => {
			return dialogRequest("editor", { title, prefill }, undefined, undefined, (response) =>
				"cancelled" in response && response.cancelled
					? undefined
					: "value" in response
						? response.value
						: undefined,
			);
		},
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme(): Theme {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching is not supported in daemon mode" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
		bell: () => emitUiRequest("bell", {}),
	};
}

function hasExtensionUiClientForMethod(state: ActiveSessionState, method: string): boolean {
	if (!isDaemonDialogExtensionUiRequest(method)) {
		return state.clients.size > 0;
	}
	return [...state.clients].some((client) => client.supportsExtensionUi);
}

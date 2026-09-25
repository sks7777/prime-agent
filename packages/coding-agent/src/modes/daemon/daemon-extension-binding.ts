import { randomUUID } from "node:crypto";
import { type Component, isKeyRelease } from "@earendil-works/pi-tui";
import type {
	ExtensionCommandContextActions,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.js";
import { KeybindingsManager } from "../../core/keybindings.js";
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
	isDaemonKeyUiResponse,
} from "./daemon-protocol.js";

/**
 * Fallbacks used until the first client key event reports a terminal width.
 * Height matches InteractiveMode.MAX_WIDGET_LINES — the client caps custom
 * widget display at that many lines, so components must window themselves
 * to the same budget or their lower rows render invisibly off the cap.
 */
const DEFAULT_CUSTOM_WIDGET_WIDTH = 120;
const DEFAULT_CUSTOM_WIDGET_HEIGHT = 10;

/** Plausible terminal column upper bound; clients report real terminal sizes. */
const MAX_CUSTOM_WIDGET_WIDTH = 1000;

function isSaneWidgetWidth(width: number | undefined): width is number {
	return width !== undefined && Number.isInteger(width) && width > 0 && width <= MAX_CUSTOM_WIDGET_WIDTH;
}

function agentDirFor(state: ActiveSessionState): string {
	return state.runtime.services.agentDir;
}

const keybindingsBySession = new WeakMap<ActiveSessionState, KeybindingsManager>();

function keybindingsFor(state: ActiveSessionState): KeybindingsManager {
	let keybindings = keybindingsBySession.get(state);
	if (!keybindings) {
		keybindings = KeybindingsManager.create(agentDirFor(state));
		keybindingsBySession.set(state, keybindings);
	}
	return keybindings;
}

export interface ActiveSessionBindingCallbacks {
	broadcast: (state: ActiveSessionState, message: DaemonOutbound) => void;
	createConnectionState?: (state: ActiveSessionState) => AgentConnectionState;
	/** May be async (the daemon's rebind awaits cron-store locks); awaited before session_replaced. */
	sessionReplaced?: (state: ActiveSessionState) => void | Promise<void>;
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
		// A floating promise here would let clients observe pre-rebind job state
		// and turn a cron-store failure into an unhandled rejection.
		await callbacks.sessionReplaced?.(state);
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
			let component: Component & { dispose?(): void; handleInput?(data: string): void };
			let closed = false;
			let currentWidth = DEFAULT_CUSTOM_WIDGET_WIDTH;

			// Coalesce renders across one microtask: components that call
			// tui.requestRender() inside handleInput would otherwise double-render
			// (once from requestRender, once from the key handler below), and the
			// real TUI coalesces requestRender the same way.
			let renderScheduled = false;
			const renderWidget = () => {
				if (closed || renderScheduled) return;
				renderScheduled = true;
				queueMicrotask(() => {
					renderScheduled = false;
					if (closed) return;
					try {
						const lines = component?.render(currentWidth) ?? [];
						if (Array.isArray(lines) && lines.length > 0) {
							emitUiRequest("setWidget", {
								widgetKey,
								widgetLines: lines,
								widgetPlacement: "aboveEditor",
							});
						}
					} catch {
						// Extension UI component may throw on render
					}
				});
			};

			// Proxy TUI: requestRender → re-render component → send via setWidget.
			// The client reports its terminal width with every forwarded key event.
			const proxyTui = {
				height: DEFAULT_CUSTOM_WIDGET_HEIGHT,
				// Headless components (pi-tui Editor, extension widgets) read
				// terminal.rows/columns off the TUI object; expose the widget-sized
				// viewport so they do not crash on an undefined terminal.
				get terminal() {
					return { columns: currentWidth, rows: DEFAULT_CUSTOM_WIDGET_HEIGHT };
				},
				requestRender: renderWidget,
				setFocus: () => {},
			};

			const keybindings = keybindingsFor(state);

			return new Promise<T>((resolveCustom) => {
				const finish = (result: T) => {
					if (closed) return;
					closed = true;
					try {
						component?.dispose?.();
					} catch {
						// Extension UI component may throw on dispose
					}
					emitUiRequest("setWidget", { widgetKey, widgetLines: undefined });
					state.extensionUiRequests.delete(requestId);
					resolveCustom(result);
				};

				// Store handler for key events from client. { key } responses keep the
				// pending request alive (daemon-mode handleCommand resolves without
				// deleting); only terminal responses (value/cancelled/confirmed)
				// resolve custom().
				state.extensionUiRequests.set(requestId, {
					resolve: (response) => {
						if (isDaemonKeyUiResponse(response)) {
							if (isSaneWidgetWidth(response.width)) {
								currentWidth = response.width;
							}
							if (!closed && component?.handleInput) {
								// Kitty-protocol terminals (xterm.js/VS Code, kitty) report key
								// release as a separate event; the real TUI drops those unless the
								// component opts in via wantsKeyRelease. Apply the same filter here,
								// or every keypress dispatches twice in those terminals.
								if (isKeyRelease(response.key) && !component.wantsKeyRelease) {
									return;
								}
								try {
									component.handleInput(response.key);
									renderWidget();
								} catch {
									// Extension UI component may throw on unexpected key input
								}
							}
						} else if ("value" in response) {
							finish(response.value as T);
						} else {
							// cancelled, confirmed, or any unexpected shape: settle
							// as cancelled so the widget always clears.
							finish(undefined as T);
						}
					},
				});

				// Create the component by calling the factory
				Promise.resolve(factory(proxyTui, theme, keybindings, finish))
					.then((c) => {
						if (closed) return;
						component = c;
						renderWidget();
					})
					.catch(() => {
						/* factory error */ finish(undefined as T);
					});
			});
		},
		startSideQuestion: (question) => emitUiRequest("start_side_question", { question }),
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

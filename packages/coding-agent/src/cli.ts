#!/usr/bin/env node
import { EnvHttpProxyAgent, setGlobalDispatcher, fetch as undiciFetch } from "undici";
// The Node 22+ module graph fails at link time on older Node, so it must load
// behind the dynamic import, after the dependency-free guard runs.
import { assertNodeVersion } from "./cli/node-version-check.js";

const supported = assertNodeVersion({
	version: process.versions.node,
	log: console.error,
	exit: (code) => process.exit(code),
});

if (supported) {
	// bodyTimeout/headersTimeout default to 300s in undici; long local-LLM stalls
	// (e.g. vLLM buffering a large tool call) exceed that and abort the SSE stream
	// with UND_ERR_BODY_TIMEOUT. Disable both — provider SDKs enforce their own
	// AbortController-based deadlines via retry.provider.timeoutMs.
	// Node 26 uses an internal undici for globalThis.fetch that does not honor npm
	// undici's global dispatcher, so route global fetch through npm undici as well.
	const dispatcher = new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 });
	setGlobalDispatcher(dispatcher);
	const fetchWithDispatcher = undiciFetch as unknown as typeof fetch;
	globalThis.fetch = (input, init) =>
		fetchWithDispatcher(input, {
			...init,
			dispatcher,
		} as unknown as RequestInit);

	const { runCli } = await import("./cli-main.js");
	await runCli();
}

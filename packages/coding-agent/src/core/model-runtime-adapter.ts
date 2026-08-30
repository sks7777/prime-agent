import type { Api, Model } from "@earendil-works/pi-ai";
import type { AuthStorage } from "./auth-storage.js";
import type { ModelRegistry } from "./model-registry.js";

/**
 * Adapter that wraps PI's ModelRegistry + AuthStorage behind a
 * earendil-compatible ModelRuntime API surface.
 *
 * PI code continues to use ModelRegistry directly.
 * Earendil code (llama extension, model-catalog-refresh, etc.) uses this adapter.
 */
export interface ProviderAuthResult {
	auth: {
		apiKey: string;
		baseUrl?: string;
	};
	env?: Record<string, string | undefined>;
}

export interface ModelsRefreshResult {
	aborted: boolean;
	errors: Map<string, Error>;
}

export interface ModelRuntimeAdapter {
	getProviders(): readonly { id: string; name?: string }[];
	getModels(provider?: string): readonly Model<Api>[];
	getModel(provider: string, id: string): Model<Api> | undefined;
	getAll(): readonly Model<Api>[];
	getAvailable(): readonly Model<Api>[];
	refresh(options?: { providers?: string[]; signal?: AbortSignal }): Promise<ModelsRefreshResult>;
	getProviderAuth(providerId: string): Promise<ProviderAuthResult | undefined>;
	checkAuth(providerId: string): Promise<{ configured: boolean } | undefined>;
	setRuntimeApiKey(providerId: string, apiKey: string): void;
	getProviderDisplayName(providerId: string): string;
}

export function createModelRuntimeAdapter(registry: ModelRegistry, authStorage: AuthStorage): ModelRuntimeAdapter {
	return {
		getProviders() {
			return registry.getAll().reduce((acc: { id: string; name?: string }[], m) => {
				if (!acc.find((p) => p.id === m.provider)) {
					acc.push({ id: m.provider, name: registry.getProviderDisplayName(m.provider) });
				}
				return acc;
			}, []);
		},

		getModels(provider?: string) {
			const all = registry.getAll();
			return provider ? all.filter((m) => m.provider === provider) : all;
		},

		getModel(provider: string, id: string) {
			return registry.getAll().find((m) => m.provider === provider && m.id === id);
		},

		getAll() {
			return registry.getAll();
		},

		getAvailable() {
			return registry.getAvailable();
		},

		async refresh(options?: { providers?: string[]; signal?: AbortSignal }) {
			const errors = new Map<string, Error>();
			try {
				if (options?.signal?.aborted) {
					return { aborted: true, errors };
				}
				// PI's refresh is synchronous — wrap in Promise for compatibility
				registry.refresh();
				// Also refresh available models
				if (options?.providers?.length) {
					await registry.refreshAvailableModels();
				}
			} catch (error) {
				if (options?.providers) {
					for (const p of options.providers) {
						errors.set(p, error as Error);
					}
				}
			}
			return { aborted: options?.signal?.aborted ?? false, errors };
		},

		async getProviderAuth(providerId: string) {
			const apiKey = await authStorage.getApiKey(providerId);
			if (!apiKey) return undefined;
			return {
				auth: { apiKey, baseUrl: undefined },
				env: undefined,
			};
		},

		async checkAuth(providerId: string) {
			const status = authStorage.getAuthStatus(providerId);
			return { configured: status?.configured ?? false };
		},

		setRuntimeApiKey(providerId: string, apiKey: string) {
			authStorage.setRuntimeApiKey(providerId, apiKey);
		},

		getProviderDisplayName(providerId: string) {
			return registry.getProviderDisplayName(providerId);
		},
	};
}

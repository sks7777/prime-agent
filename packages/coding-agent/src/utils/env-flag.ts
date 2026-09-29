/**
 * Shared PI_* environment truthiness convention: 1 / true / yes (case-insensitive).
 * All new PI_OFFLINE/PI_TIMING-style boolean env readers should delegate here.
 */
export function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

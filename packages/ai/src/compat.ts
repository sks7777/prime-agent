/**
 * Compatibility entry point for extensions that import `@earendil-works/pi-ai/compat`.
 *
 * Re-exports the full root entry (stream/complete, api registry, types) so
 * extensions written against upstream pi-ai's compat subpath keep resolving.
 */
export * from "./index.js";

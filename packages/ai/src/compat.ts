/**
 * Compatibility entry point for extensions that import `@earendil-works/pi-ai/compat`.
 *
 * Re-exports `streamSimple` and `completeSimple` from the root entry so
 * extensions written against pi-ai versions that moved these functions
 * behind a `/compat` subpath continue to resolve.
 */
export { completeSimple, streamSimple } from "./stream.js";

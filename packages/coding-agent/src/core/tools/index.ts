export { acpMcpToolNames, createAcpMcpToolDefinitions } from "./acp-mcp.js";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.js";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export {
	createIpythonTool,
	createIpythonToolDefinition,
	IpythonKernelProvisioner,
	type IpythonToolDetails,
	type IpythonToolInput,
	type IpythonToolOptions,
} from "./ipython.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createIpythonTool, createIpythonToolDefinition, type IpythonToolOptions } from "./ipython.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "ipython";

export interface ToolsOptions {
	ipython?: IpythonToolOptions;
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		ipython: createIpythonToolDefinition(cwd, options?.ipython),
	};
}

/**
 * Create the session built-in coding tools for a working directory.
 * Compat factory for pi extensions written against upstream pi (>= v0.84):
 * the fork's session built-in tool is the ipython kernel; bash and edit are
 * real agent tools available to SDK embedders via customTools.
 */
export function createCodingTools(cwd: string): Tool[] {
	return [createIpythonTool(cwd), createBashTool(cwd), createEditTool(cwd)];
}

/**
 * Create the read-only built-in tools for a working directory.
 * Compat factory for pi extensions written against upstream pi (>= v0.84):
 * reading and searching run through the ipython kernel (read/search helpers)
 * and the read-only bash surface.
 */
export function createReadOnlyTools(cwd: string): Tool[] {
	return [createIpythonTool(cwd), createBashTool(cwd)];
}

// @ts-nocheck
import { type ClientCommandContext, clientCommand } from "./commands/client.js";
import { type PiCommandContext, piCommand } from "./commands/pi.js";
import { type ServerCommandContext, serverCommand } from "./commands/server.js";

export type ExperimentalCliContext = PiCommandContext & ServerCommandContext & ClientCommandContext;

export const experimentalCli = piCommand.command(serverCommand).command(clientCommand);

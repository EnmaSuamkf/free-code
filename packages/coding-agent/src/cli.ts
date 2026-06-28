#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { APP_NAME, ENV_AGENT_PREFIX } from "./config.js";
import { main } from "./main.js";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.env[`${ENV_AGENT_PREFIX}_CODING_AGENT`] = "true";

setGlobalDispatcher(new EnvHttpProxyAgent());

main(process.argv.slice(2));

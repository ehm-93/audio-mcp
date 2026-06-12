#!/usr/bin/env node
/**
 * mixdown: a local MCP server for designing, analyzing, and exporting game
 * sound effects as deterministic synthesis recipes.
 *
 * Usage: mixdown [workspace-dir]
 * The workspace defaults to $MIXDOWN_WORKSPACE, then the current directory.
 */

import * as path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./tools.js";

const root = path.resolve(process.argv[2] ?? process.env.MIXDOWN_WORKSPACE ?? process.cwd());

const { server } = await createServer(root);
const transport = new StdioServerTransport();
await server.connect(transport);

// stdout carries the protocol; log to stderr only
console.error(`mixdown 0.3.0 ready, workspace: ${root}`);

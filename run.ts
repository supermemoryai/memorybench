#!/usr/bin/env bun
/**
 * MemoryBench Run Script
 * Allows running: bun run --benchmark <name> --provider <name> [options]
 */

import { CliParser } from './cli/CliParser';
import { CommandHandler } from './cli/CommandHandler';

// Extract arguments after "run" command
const args = process.argv.slice(2);

// If first arg is a known benchmark command pattern, pass it through
const command = args[0];

// Check if this looks like a run command (starts with --)
const isRunCommand = args.some(arg => arg === '--benchmark' || arg === '--provider');

async function main() {
    try {
        const cliParser = new CliParser();
        
        // If we have benchmark/provider flags, it's a run command
        let parseArgs = args;
        if (isRunCommand) {
            parseArgs = ['run', ...args];
        } else if (!args.length) {
            parseArgs = ['help'];
        }
        
        const parsedCommand = cliParser.parse(parseArgs);
        const handler = new CommandHandler();
        await handler.handle(parsedCommand);
    } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : error);
        process.exit(1);
    }
}

main();

#!/usr/bin/env bun
/**
 * MemoryBench CLI - Main Entry Point
 * Usage: memorybench <command> [options]
 * 
 * Examples:
 *   memorybench run --benchmark LongMemEval --provider supermemory
 *   memorybench run --benchmark LoCoMo --provider mem0 --limit=5
 *   memorybench list-benchmarks
 *   memorybench list-providers
 *   memorybench help
 */

import { CliParser } from '../cli/CliParser';
import { CommandHandler } from '../cli/CommandHandler';
import { logger } from '../cli/Logger';

async function main() {
    try {
        const cliParser = new CliParser();
        const command = cliParser.parse(process.argv.slice(2));

        const handler = new CommandHandler();
        await handler.handle(command);
    } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

main();

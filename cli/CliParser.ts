/**
 * CLI Parser - Parses command line arguments
 * Supports:
 *   memorybench run --benchmark <name> --provider <name> [options]
 *   memorybench list-benchmarks
 *   memorybench list-providers
 *   memorybench help
 */

export interface RunCommand {
    type: 'run';
    benchmark: string;
    provider: string;
    options: Record<string, string | number | boolean>;
}

export interface ListCommand {
    type: 'list-benchmarks' | 'list-providers' | 'help';
}

export type Command = RunCommand | ListCommand;

export class CliParser {
    parse(args: string[]): Command {
        if (args.length === 0) {
            return { type: 'help' };
        }

        const mainCommand = args[0];

        // Simple help commands
        if (mainCommand === 'help' || mainCommand === '--help' || mainCommand === '-h') {
            return { type: 'help' };
        }

        if (mainCommand === 'list-benchmarks') {
            return { type: 'list-benchmarks' };
        }

        if (mainCommand === 'list-providers') {
            return { type: 'list-providers' };
        }

        // Parse 'run' command
        if (mainCommand === 'run') {
            return this.parseRunCommand(args.slice(1));
        }

        throw new Error(`Unknown command: ${mainCommand}. Use 'memorybench help' for usage information.`);
    }

    private parseRunCommand(args: string[]): RunCommand {
        const options: Record<string, string | number | boolean> = {};
        let benchmark: string | null = null;
        let provider: string | null = null;

        for (let i = 0; i < args.length; i++) {
            const arg = args[i];

            if (arg === '--benchmark') {
                i++;
                if (i >= args.length) {
                    throw new Error('--benchmark requires a value');
                }
                benchmark = args[i];
            } else if (arg === '--provider') {
                i++;
                if (i >= args.length) {
                    throw new Error('--provider requires a value');
                }
                provider = args[i];
            } else if (arg.startsWith('--')) {
                // Handle other options
                const parts = arg.substring(2).split('=');
                const key = parts[0];
                let value: string | number | boolean;

                if (parts.length === 2) {
                    // --key=value format
                    value = this.parseValue(parts[1]);
                } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
                    // --key value format
                    i++;
                    value = this.parseValue(args[i]);
                } else {
                    // --flag format (boolean)
                    value = true;
                }

                options[key] = value;
            }
        }

        if (!benchmark) {
            throw new Error('--benchmark is required. Use "memorybench help" for usage information.');
        }

        if (!provider) {
            throw new Error('--provider is required. Use "memorybench help" for usage information.');
        }

        return { type: 'run', benchmark, provider, options };
    }

    private parseValue(value: string): string | number | boolean {
        // Try to parse as number
        if (/^\d+$/.test(value)) {
            return parseInt(value, 10);
        }

        // Try to parse as boolean
        if (value.toLowerCase() === 'true') {
            return true;
        }
        if (value.toLowerCase() === 'false') {
            return false;
        }

        // Default to string
        return value;
    }
}

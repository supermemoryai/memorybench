/**
 * Logger - Provides structured logging for the CLI
 */

export enum LogLevel {
    DEBUG = 'DEBUG',
    INFO = 'INFO',
    WARN = 'WARN',
    ERROR = 'ERROR',
    SUCCESS = 'SUCCESS',
}

export class Logger {
    private startTime: Map<string, number> = new Map();

    log(message: string, level: LogLevel = LogLevel.INFO): void {
        const timestamp = new Date().toLocaleTimeString();
        const prefix = this.getPrefix(level);
        console.log(`${prefix} ${message}`);
    }

    info(message: string): void {
        this.log(message, LogLevel.INFO);
    }

    debug(message: string): void {
        if (process.env.DEBUG) {
            this.log(message, LogLevel.DEBUG);
        }
    }

    warn(message: string): void {
        this.log(message, LogLevel.WARN);
    }

    error(message: string): void {
        this.log(message, LogLevel.ERROR);
    }

    success(message: string): void {
        this.log(message, LogLevel.SUCCESS);
    }

    section(title: string): void {
        console.log('');
        console.log('='.repeat(60));
        console.log(`  ${title}`);
        console.log('='.repeat(60));
        console.log('');
    }

    subsection(title: string): void {
        console.log('');
        console.log(`  ${title}`);
        console.log('  ' + '-'.repeat(56));
    }

    startTimer(key: string): void {
        this.startTime.set(key, Date.now());
    }

    endTimer(key: string, label: string = key): string {
        const start = this.startTime.get(key);
        if (!start) {
            return 'unknown time';
        }

        const elapsed = Date.now() - start;
        const seconds = (elapsed / 1000).toFixed(2);
        this.startTime.delete(key);

        return `${seconds}s`;
    }

    logTimer(key: string, label: string = key): void {
        const time = this.endTimer(key, label);
        this.info(`${label} completed in ${time}`);
    }

    progress(current: number, total: number, label: string = ''): void {
        const percent = ((current / total) * 100).toFixed(1);
        const barLength = 30;
        const filled = Math.round((current / total) * barLength);
        const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);

        let message = `[${bar}] ${percent}% (${current}/${total})`;
        if (label) {
            message += ` - ${label}`;
        }

        this.info(message);
    }

    table(data: Record<string, string | number>): void {
        console.log('');
        const entries = Object.entries(data);
        const maxKeyLength = Math.max(...entries.map(([key]) => key.length));

        for (const [key, value] of entries) {
            const paddedKey = key.padEnd(maxKeyLength, ' ');
            console.log(`  ${paddedKey} : ${value}`);
        }
        console.log('');
    }

    private getPrefix(level: LogLevel): string {
        const timestamp = new Date().toLocaleTimeString();

        switch (level) {
            case LogLevel.SUCCESS:
                return `✓ [${timestamp}]`;
            case LogLevel.ERROR:
                return `✗ [${timestamp}]`;
            case LogLevel.WARN:
                return `⚠ [${timestamp}]`;
            case LogLevel.DEBUG:
                return `🔍 [${timestamp}]`;
            case LogLevel.INFO:
            default:
                return `ℹ [${timestamp}]`;
        }
    }
}

// Singleton instance
export const logger = new Logger();

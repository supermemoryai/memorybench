type LogLevel = "debug" | "info" | "warn" | "error"

const COLORS = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  reset: "\x1b[0m",
  green: "\x1b[32m",
}

class Logger {
  private level: LogLevel = "info"

  setLevel(level: LogLevel) {
    this.level = level
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ["debug", "info", "warn", "error"]
    return levels.indexOf(level) >= levels.indexOf(this.level)
  }

  private format(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString()
    const color = COLORS[level]
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : ""
    return `${COLORS.reset}[${timestamp}] ${color}${level.toUpperCase()}${COLORS.reset} ${message}${metaStr}`
  }

  debug(message: string, meta?: Record<string, unknown>) {
    if (this.shouldLog("debug")) console.log(this.format("debug", message, meta))
  }

  info(message: string, meta?: Record<string, unknown>) {
    if (this.shouldLog("info")) console.log(this.format("info", message, meta))
  }

  warn(message: string, meta?: Record<string, unknown>) {
    if (this.shouldLog("warn")) console.warn(this.format("warn", message, meta))
  }

  error(message: string, meta?: Record<string, unknown>) {
    if (this.shouldLog("error")) console.error(this.format("error", message, meta))
  }

  success(message: string) {
    console.log(`${COLORS.green}✓${COLORS.reset} ${message}`)
  }

  progress(current: number, total: number, message: string) {
    const percent = Math.round((current / total) * 100)
    const bar = "█".repeat(Math.floor(percent / 5)) + "░".repeat(20 - Math.floor(percent / 5))
    process.stdout.write(`\r${COLORS.info}[${bar}]${COLORS.reset} ${percent}% ${message}`)
    if (current === total) console.log()
  }
}

export const logger = new Logger()

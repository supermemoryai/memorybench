/**
 * Retry utility with exponential backoff
 * Handles rate limits and transient failures for API calls
 */

export interface RetryOptions {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffMultiplier?: number;
    retryableErrors?: string[];
    /** If true, return null instead of throwing after all retries fail */
    continueOnError?: boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
    maxAttempts: 5,
    initialDelayMs: 1000,
    maxDelayMs: 60000,
    backoffMultiplier: 2,
    retryableErrors: [
        'rate_limit',
        'Rate limit',
        'rate limit',
        '429',
        'Too Many Requests',
        'RATE_LIMIT_EXCEEDED',
        'Request was rejected',
        'overloaded',
        'capacity',
    ],
    continueOnError: false,
};

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error is retryable based on its message
 */
function isRetryableError(error: unknown, retryableErrors: string[]): boolean {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return retryableErrors.some(pattern => errorMessage.includes(pattern));
}

/**
 * Extract wait time from rate limit error message if available
 */
function extractWaitTime(error: unknown): number | null {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Match patterns like "try again in 10.27s" or "retry after 10 seconds"
    const patterns = [
        /try again in (\d+(?:\.\d+)?)\s*s/i,
        /retry after (\d+(?:\.\d+)?)\s*s/i,
        /wait (\d+(?:\.\d+)?)\s*s/i,
        /(\d+(?:\.\d+)?)\s*seconds?/i,
    ];

    for (const pattern of patterns) {
        const match = errorMessage.match(pattern);
        if (match && match[1]) {
            return Math.ceil(parseFloat(match[1]) * 1000); // Convert to ms
        }
    }

    return null;
}

/**
 * Result type for withRetry when continueOnError is true
 */
export type RetryResult<T> = 
    | { success: true; data: T }
    | { success: false; error: string };

/**
 * Execute a function with retry logic and exponential backoff
 * 
 * @param fn - The async function to execute
 * @param options - Retry configuration options
 * @returns The result of the function, or a RetryResult if continueOnError is true
 * @throws The last error if all retries fail (unless continueOnError is true)
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    options?: RetryOptions & { continueOnError?: false }
): Promise<T>;
export async function withRetry<T>(
    fn: () => Promise<T>,
    options: RetryOptions & { continueOnError: true }
): Promise<RetryResult<T>>;
export async function withRetry<T>(
    fn: () => Promise<T>,
    options?: RetryOptions
): Promise<T | RetryResult<T>> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    let lastError: unknown;
    let delay = opts.initialDelayMs;

    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
        try {
            const result = await fn();
            if (opts.continueOnError) {
                return { success: true, data: result };
            }
            return result;
        } catch (error) {
            lastError = error;
            const errorMessage = error instanceof Error ? error.message : String(error);

            if (!isRetryableError(error, opts.retryableErrors)) {
                // Non-retryable error
                if (opts.continueOnError) {
                    console.log(`  ✗ Non-retryable error: ${errorMessage.substring(0, 100)}`);
                    return { success: false, error: errorMessage };
                }
                throw error;
            }

            if (attempt === opts.maxAttempts) {
                // Last attempt failed
                if (opts.continueOnError) {
                    console.log(`  ✗ Failed after ${opts.maxAttempts} attempts: ${errorMessage.substring(0, 100)}`);
                    return { success: false, error: `Failed after ${opts.maxAttempts} attempts. Last error: ${errorMessage}` };
                }
                throw new Error(
                    `Failed after ${opts.maxAttempts} attempts. Last error: ${errorMessage}`
                );
            }

            // Check if the error message contains a suggested wait time
            const suggestedWait = extractWaitTime(error);
            const waitTime = suggestedWait 
                ? Math.min(suggestedWait + 1000, opts.maxDelayMs) // Add 1s buffer
                : Math.min(delay, opts.maxDelayMs);

            console.log(
                `  ⚠ Rate limited (attempt ${attempt}/${opts.maxAttempts}). ` +
                `Waiting ${(waitTime / 1000).toFixed(1)}s before retry...`
            );

            await sleep(waitTime);

            // Exponential backoff for next attempt
            delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs);
        }
    }

    // Should not reach here, but just in case
    if (opts.continueOnError) {
        const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
        return { success: false, error: errorMessage };
    }
    throw lastError;
}

/**
 * Create a rate-limited version of an async function
 * Adds automatic retry with exponential backoff
 */
export function withRateLimitRetry<TArgs extends any[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
    options?: RetryOptions
): (...args: TArgs) => Promise<TResult> {
    return (...args: TArgs) => withRetry(() => fn(...args), options);
}


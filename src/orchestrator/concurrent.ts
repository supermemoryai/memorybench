import { logger } from "../utils/logger"
import { shouldStop } from "../server/runState"

export interface ConcurrentTaskContext<T> {
  item: T
  index: number
  total: number
}

export interface ConcurrentExecutionOptions<T, R> {
  items: T[]
  concurrency: number
  rateLimitMs: number
  runId: string
  phaseName: string
  executeTask: (context: ConcurrentTaskContext<T>) => Promise<R>
  onBatchStart?: (batchIndex: number, batchSize: number) => void
  onBatchComplete?: (batchIndex: number, results: R[]) => void
  onTaskComplete?: (context: ConcurrentTaskContext<T>, result: R) => void
  onError?: (context: ConcurrentTaskContext<T>, error: Error) => void
}

export class ConcurrentExecutor {
  /**
   * Run tasks with `concurrency` of them in flight at all times.
   *
   * This used to slice the items into batches of `concurrency` and await each
   * batch before starting the next. A batch then costs the *slowest* of its
   * members, not the average, and with a long tail that is brutal: the 500
   * answers of a full500 have a median of 8.6 s but a p99 of 90 s, so batches
   * of six took 45 minutes where the concurrency alone predicts twelve. A
   * sliding window starts the next item the moment any one finishes.
   *
   * Semantics preserved: fail-fast (the first error still throws, and tasks
   * already in flight are still allowed to finish), stop-on-request, per-task
   * callbacks, and results in item order.
   */
  static async executeBatched<T, R>(options: ConcurrentExecutionOptions<T, R>): Promise<R[]> {
    const {
      items,
      concurrency,
      rateLimitMs,
      runId,
      phaseName,
      executeTask,
      onBatchStart,
      onBatchComplete,
      onTaskComplete,
      onError,
    } = options

    if (items.length === 0) return []
    if (concurrency <= 0) throw new Error("Concurrency must be positive")

    logger.info(
      `[${phaseName}] Processing ${items.length} items, ${concurrency} in flight`
    )

    const results = new Array<R | undefined>(items.length)
    let next = 0
    let failure: Error | null = null
    let stopped = false
    // Rate limiting used to be a pause between batches. With no batches, the
    // equivalent is a minimum spacing between task starts.
    let nextStartAt = 0

    const worker = async (): Promise<void> => {
      for (;;) {
        if (failure || stopped) return
        if (shouldStop(runId)) {
          stopped = true
          return
        }
        const index = next++
        if (index >= items.length) return

        if (rateLimitMs > 0) {
          const wait = nextStartAt - Date.now()
          nextStartAt = Math.max(Date.now(), nextStartAt) + rateLimitMs
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
        }

        const context: ConcurrentTaskContext<T> = { item: items[index], index, total: items.length }
        onBatchStart?.(index, 1)
        try {
          const result = await executeTask(context)
          onTaskComplete?.(context, result)
          results[index] = result
          onBatchComplete?.(index, [result])
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          onError?.(context, err)
          // Stop handing out new work; workers already inside executeTask run
          // to completion before Promise.all below resolves.
          if (!failure) failure = err
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
    )

    if (failure) throw failure
    if (stopped) throw new Error(`Run stopped by user. Resume with the same run ID.`)
    return results.filter((r): r is R => r !== undefined)
  }

  /**
   * Simple concurrent execution without batching (for phases without rate limits)
   */
  static async execute<T, R>(
    items: T[],
    concurrency: number,
    runId: string,
    phaseName: string,
    executeTask: (context: ConcurrentTaskContext<T>) => Promise<R>
  ): Promise<R[]> {
    return this.executeBatched({
      items,
      concurrency,
      rateLimitMs: 0,
      runId,
      phaseName,
      executeTask,
    })
  }
}

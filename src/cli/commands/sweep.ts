import { parseArgs } from "node:util"
import { runContextSweep } from "../../orchestrator/sweep"
import { logger } from "../../utils/logger"

export async function sweepCommand(args: string[]): Promise<void> {
  try {
    const { values } = parseArgs({
      args,
      options: {
        from: { type: "string" },
        "sweep-id": { type: "string" },
        depths: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    })
    if (values.help) {
      console.log(
        "Usage: bun run src/index.ts sweep --from <run-id> --sweep-id <id> --depths 0,1,5"
      )
      return
    }
    if (
      !values.from ||
      !values["sweep-id"] ||
      !values.depths ||
      !/^\d+(,\d+)*$/.test(values.depths)
    ) {
      throw new Error("Provide --from, --sweep-id and --depths (for example, 0,1,5).")
    }
    const reports = await runContextSweep({
      sourceRunId: values.from,
      sweepId: values["sweep-id"],
      depths: values.depths.split(",").map(Number),
    })
    console.table(
      reports.map((report) => ({
        run: report.runId,
        "max results": report.contextSweep!.maxResults,
        "avg results": Number(
          (
            report.evaluations.reduce((total, row) => total + row.searchResults.length, 0) /
            report.evaluations.length
          ).toFixed(1)
        ),
        questions: report.summary.totalQuestions,
        accuracy: `${(report.summary.accuracy * 100).toFixed(1)}%`,
        ...(report.summary.headline && {
          "headline accuracy": `${(report.summary.headline.accuracy * 100).toFixed(1)}%`,
        }),
        "avg context tokens": report.tokens?.avgContextTokens,
        "answer p95 (ms)": report.latency.answer.p95,
      }))
    )
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

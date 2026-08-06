import { prepareBeamDataset } from "../../benchmarks/beam/prepare"
import type { BeamScale } from "../../benchmarks/beam/types"

const DEFAULT_OUTPUT_ROOT = "./data/benchmarks/beam"

function parseTiers(value: string): BeamScale[] {
  const tiers = value.split(",").map((tier) => tier.trim())
  if (tiers.length === 0 || tiers.some((tier) => tier !== "1M" && tier !== "10M")) {
    throw new Error(`Invalid BEAM tiers ${value}; use 1M, 10M, or 1M,10M`)
  }
  return tiers as BeamScale[]
}

export async function beamCommand(args: string[]): Promise<void> {
  const subcommand = args[0]
  if (subcommand !== "prepare") {
    console.log("Usage: bun run src/index.ts beam prepare [--tiers 1M,10M] [--output <path>]")
    return
  }

  let tiers: BeamScale[] = ["1M", "10M"]
  let outputRoot = DEFAULT_OUTPUT_ROOT
  for (let index = 1; index < args.length; index++) {
    const argument = args[index]
    if (argument === "--tiers") {
      const value = args[++index]
      if (!value) throw new Error("--tiers requires a value")
      tiers = parseTiers(value)
    } else if (argument === "--output" || argument === "--data-path") {
      const value = args[++index]
      if (!value) throw new Error(`${argument} requires a value`)
      outputRoot = value
    } else {
      throw new Error(`Unknown beam prepare option: ${argument}`)
    }
  }

  const prepared = await prepareBeamDataset({ tiers, outputRoot })
  console.log(`Prepared BEAM ${tiers.join("/")} snapshot: ${prepared.snapshotPath}`)
  console.log(`Dataset fingerprint: ${prepared.manifest.datasetFingerprint}`)
  console.log(
    `Run with --data-path ${outputRoot} --dataset-revision ${prepared.manifest.datasetFingerprint}`
  )
}

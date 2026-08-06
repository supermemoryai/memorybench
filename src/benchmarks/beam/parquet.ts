import { open, stat } from "node:fs/promises"
import type { BeamScale } from "./types"

export type BeamParquetDecoder = (filePath: string, tier: BeamScale) => Promise<unknown[]>

/**
 * Decode an on-disk Parquet file through range reads so preparation and
 * scored-run provenance verification execute the same decoder.
 */
export async function decodeBeamParquetWithHyparquet(
  filePath: string,
  _tier: BeamScale
): Promise<unknown[]> {
  const hyparquetModuleName = "hyparquet"
  const compressorsModuleName = "hyparquet-compressors"
  let hyparquet: Record<string, unknown>
  let compressorModule: Record<string, unknown>
  try {
    hyparquet = (await import(hyparquetModuleName)) as Record<string, unknown>
    compressorModule = (await import(compressorsModuleName)) as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `BEAM preparation and provenance verification require hyparquet and hyparquet-compressors: ${String(error)}`
    )
  }

  const parquetReadObjects = hyparquet.parquetReadObjects
  if (typeof parquetReadObjects !== "function") {
    throw new Error("Installed hyparquet package does not export parquetReadObjects")
  }
  const compressors = compressorModule.compressors ?? compressorModule.default
  if (!compressors || typeof compressors !== "object") {
    throw new Error("Installed hyparquet-compressors package does not export compressors")
  }

  const fileStat = await stat(filePath)
  const handle = await open(filePath, "r")
  const asyncBuffer = {
    byteLength: fileStat.size,
    slice: async (start: number, end: number): Promise<ArrayBuffer> => {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
        throw new Error(`Invalid Parquet byte range: ${start}-${end}`)
      }
      const length = Math.min(end, fileStat.size) - start
      const target = Buffer.alloc(Math.max(0, length))
      const { bytesRead } = await handle.read(target, 0, target.byteLength, start)
      if (bytesRead !== target.byteLength) {
        throw new Error(`Short Parquet read at ${start}-${end}: got ${bytesRead} bytes`)
      }
      return target.buffer.slice(target.byteOffset, target.byteOffset + target.byteLength)
    },
  }

  try {
    return (await (
      parquetReadObjects as (options: {
        file: typeof asyncBuffer
        compressors: unknown
      }) => Promise<unknown[]>
    )({ file: asyncBuffer, compressors })) as unknown[]
  } finally {
    await handle.close()
  }
}

import { spawnSync } from "child_process"
import { existsSync } from "fs"
import { join } from "path"

/** Forwards to dolphinbench/mb_run.py, using the Python environment that `dolphinbench setup` builds */
export async function dolphinbenchCommand(args: string[]): Promise<void> {
  const root = join(import.meta.dir, "../../..")
  const venvPython = join(root, "data/dolphinbench/.venv/bin/python")
  const python = existsSync(venvPython) ? venvPython : "python3"
  const result = spawnSync(python, [join(root, "dolphinbench/mb_run.py"), ...args], { stdio: "inherit" })
  process.exit(result.status ?? 1)
}

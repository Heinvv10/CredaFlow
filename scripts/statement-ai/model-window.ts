/**
 * The shared local model may be used for dev runs and evaluations only after
 * 17:00 SAST on weekdays, or at weekends, and never while a demo bake runs
 * (goal 2026-10-17 §7). Throws otherwise; ALLOW_MODEL_WINDOW=1 skips the clock
 * (never the bake check).
 */
import { execFileSync } from "node:child_process"

function running(pattern: string): boolean {
  try {
    return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).trim().length > 0
  } catch {
    return false
  }
}

export function assertModelWindow(now = new Date()): void {
  const sast = new Date(now.getTime() + 2 * 3_600_000)
  const day = sast.getUTCDay()
  const weekend = day === 0 || day === 6
  if (!weekend && sast.getUTCHours() < 17 && process.env.ALLOW_MODEL_WINDOW !== "1") {
    throw new Error("The shared model is for business use until 17:00 SAST on weekdays.")
  }
  if (running("^(timeout [0-9]+ )?bash scripts/demo/bake\\.sh") || running("^node .*scripts/demo/simulate\\.ts")) {
    throw new Error("A demo bake is running: it needs the shared model.")
  }
}

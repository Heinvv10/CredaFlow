/**
 * Shared wiring for the demo simulator: where the sim stack listens, where
 * its untracked env file lives, and a stderr progress logger (stdout stays
 * free for whatever a caller wants to pipe).
 */
import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseEnv } from "node:util"

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..")

/** The untracked env file docker-compose.demo-sim.yml loads. */
export const SIM_ENV_FILE = path.join(REPO_ROOT, ".env.demo-sim")

/**
 * Secrets the bake shares with the live demo (scripts/demo/lib.sh); the sim
 * app loads it after .env.demo-sim, so its values win, as they do here.
 */
export const SHARED_SECRETS_FILE = path.join(
  process.env.DEMO_DATA_DIR ?? path.join(os.homedir(), "credaflow-demo-data"),
  "secrets.env",
)

/** Directory bind-mounted read-only into both sim containers at /sim-clock. */
export const SIM_CLOCK_DIR = path.join(REPO_ROOT, "scripts", "demo", ".sim-clock")

/** Seed credentials captured for the simulator (chmod 600, untracked). */
export const SIM_CREDENTIALS_FILE = path.join(REPO_ROOT, "scripts", "demo", ".sim-credentials.txt")

/** Origin of the sim app (127.0.0.1-bound). Override with SIM_BASE_URL. */
export function simBaseUrl(): string {
  return (process.env.SIM_BASE_URL ?? "http://localhost:3320").replace(/\/+$/, "")
}

/** Reads one key from .env.demo-sim + the shared secrets file; throws if a file or the key is missing. */
export function simEnv(key: string): string {
  const parsed = {
    ...parseEnv(readFileSync(SIM_ENV_FILE, "utf8")),
    ...parseEnv(readFileSync(SHARED_SECRETS_FILE, "utf8")),
  }
  const value = parsed[key]
  if (!value) throw new Error(`${key} is not set in ${SIM_ENV_FILE} or ${SHARED_SECRETS_FILE}`)
  return value
}

export function log(message: string): void {
  process.stderr.write(`[sim] ${message}\n`)
}

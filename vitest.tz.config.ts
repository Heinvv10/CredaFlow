import baseConfig from "./vitest.config"
import { defineConfig, mergeConfig } from "vitest/config"

/**
 * The base config pins `TZ=UTC` for every worker, which is right for the suite
 * as a whole — a dev box here runs SAST, and under SAST a helper that forgot
 * its `timeZone` argument passes because the machine supplies it.
 *
 * That pin also means `TZ=X npm test` silently has no effect: the worker is
 * UTC whatever the shell says. Proving a date helper is zone-independent
 * therefore needs a config that lets the outer zone through — this one. Used
 * by `npm run test:tz`, which runs the date suite under several zones.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({ test: { env: { TZ: process.env.TZ ?? "UTC" } } }),
)

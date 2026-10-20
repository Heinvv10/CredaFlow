#!/usr/bin/env tsx
/**
 * Build the conflict-free registries (docs/ARCHITECTURE.md, "Registries").
 *
 * Reads every entry file under `lib/registry/<kind>/` in path order, validates
 * the merged list (a duplicate names both files), and writes
 * `lib/registry/generated/<kind>.ts`, plus `docs/module-rules.md` from the
 * `<!-- summary: … -->` line of every nested `.claude.md`. All outputs are
 * gitignored, so two PRs that each add an entry never edit the same file.
 *
 * Runs before dev, build, test and typecheck (package.json pre-scripts,
 * postinstall, vitest globalSetup, scripts/ci-local.sh, the CI workflow).
 *
 * Usage:
 *   npm run gen:registries            # write
 *   npm run gen:registries -- --check # exit 1 if an output is missing or stale
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { validate as validCronExpression } from "node-cron"
import type { CronJob, SimulationRule } from "../lib/registry/define"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

type Entry<T> = { file: string; value: T }
type Item<T> = { file: string; key: string; value: T }

export class RegistryError extends Error {}

function fail(msg: string): never {
  throw new RegistryError(msg)
}

async function loadKind(root: string, kind: string): Promise<Entry<unknown>[]> {
  const dir = join(root, "lib", "registry", kind)
  const files: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    // Everything here is an entry file or a mistake: never skip one silently.
    if (!e.isFile() || !e.name.endsWith(".ts") || /\.(d|test|spec)\.ts$/.test(e.name)) {
      fail(`${relative(root, join(dir, e.name))}: not an entry file — entries are .ts files directly in lib/registry/${kind}/`)
    }
    files.push(e.name)
  }
  files.sort()
  const out: Entry<unknown>[] = []
  for (const f of files) {
    const file = relative(root, join(dir, f))
    const mod = (await import(pathToFileURL(join(dir, f)).href)) as { default?: unknown }
    if (mod.default === undefined) fail(`${file}: no default export`)
    out.push({ file, value: mod.default })
  }
  return out
}

/** Flattens entries into items, refusing a key two entries both declare. */
function merge<T>(kind: string, items: Item<T>[]): Item<T>[] {
  const seen = new Map<string, string>()
  for (const it of items) {
    const prev = seen.get(it.key)
    if (prev) fail(`${kind}: "${it.key}" is declared twice — ${prev} and ${it.file}`)
    seen.set(it.key, it.file)
  }
  return items
}

function objectItems<T>(kind: string, entries: Entry<unknown>[]): Item<T>[] {
  return merge(
    kind,
    entries.flatMap(({ file, value }) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${file}: expected an object`)
      return Object.entries(value as Record<string, T>).map(([key, v]) => ({ file, key, value: v }))
    }),
  )
}

function auditActions(entries: Entry<unknown>[]): Record<string, string> {
  const items = objectItems<string>("audit-actions", entries)
  for (const { file, key, value } of items) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) fail(`${file}: audit action "${key}" is not UPPER_SNAKE_CASE`)
    if (value !== key) fail(`${file}: audit action ${key} must equal its own name, got "${value}"`)
  }
  return Object.fromEntries(items.map((i) => [i.key, i.value]))
}

function tenantScopedModels(entries: Entry<unknown>[]): string[] {
  const items = merge(
    "tenant-scoped-models",
    entries.flatMap(({ file, value }) => {
      if (!Array.isArray(value)) fail(`${file}: expected an array of model names`)
      return value.map((m: unknown) => {
        if (typeof m !== "string" || !/^[A-Z][A-Za-z0-9]*$/.test(m)) fail(`${file}: "${String(m)}" is not a model name`)
        return { file, key: m, value: m }
      })
    }),
  )
  return items.map((i) => i.value)
}

function cronJobs(entries: Entry<unknown>[]): CronJob[] {
  const items = merge(
    "cron-jobs",
    entries.flatMap(({ file, value }) => {
      if (!Array.isArray(value)) fail(`${file}: expected an array of cron jobs`)
      return (value as CronJob[]).map((job) => ({ file, key: String(job?.route), value: job }))
    }),
  )
  const validateAfter = (jobs: CronJob[]): CronJob[] => {
    for (const job of jobs) {
      if (job.owner !== "in-process" || !job.after) continue
      const target = jobs.find((j) => j.route === job.after)
      if (!target || target.owner !== "in-process" || !target.singleRun) fail(`${job.route}: after "${job.after}" must name a singleRun in-process job`)
      const minuteOfDay = (j: { schedule: string }) => { const [m, h] = j.schedule.split(/\s+/).map(Number); return h * 60 + m }
      if (minuteOfDay(target) >= minuteOfDay(job)) fail(`${job.route}: after "${job.after}" must be scheduled earlier in the day`)
    }
    return jobs
  }
  const allowed = { "in-process": ["route", "owner", "schedule", "method", "freshnessMinutes", "singleRun", "after"], external: ["route", "owner"], unwired: ["route", "owner", "reason"] }
  return validateAfter(items.map(({ file, value: job }) => {
    const keys = allowed[job.owner as keyof typeof allowed]
    const extra = keys ? Object.keys(job).filter((k) => !keys.includes(k)) : []
    if (extra.length) fail(`${file}: ${job.route} (${job.owner}) does not take ${extra.join(", ")}`)
    if (!/^[a-z][a-z0-9-]*$/.test(job.route)) fail(`${file}: cron route "${job.route}" is not a /api/cron/<name> segment`)
    switch (job.owner) {
      case "in-process": {
        const fields = typeof job.schedule === "string" ? job.schedule.trim().split(/\s+/) : []
        // node-cron reads a 6-field expression's FIRST field as seconds.
        if (fields.length !== 5) fail(`${file}: ${job.route} schedule "${job.schedule}" must have exactly 5 fields`)
        // node-cron throws on an invalid expression at boot, and every job after it goes unscheduled.
        if (!validCronExpression(job.schedule)) fail(`${file}: ${job.route} schedule "${job.schedule}" is not a valid cron expression`)
        const method = job.method ?? "GET"
        if (method !== "GET" && method !== "POST") fail(`${file}: ${job.route} method must be GET or POST`)
        if (!Number.isInteger(job.freshnessMinutes) || job.freshnessMinutes <= 0) {
          fail(`${file}: ${job.route} needs a positive whole freshnessMinutes`)
        }
        if (job.singleRun !== undefined && typeof job.singleRun !== "boolean") fail(`${file}: ${job.route} singleRun must be true or false`)
        // The claim is one row per SAST day: a job firing more often than daily would run once and be skipped the rest of the day.
        if (job.singleRun && !/^\d+ \d+ \* \* \*$/.test(fields.join(" "))) {
          fail(`${file}: ${job.route} singleRun needs a once-a-day schedule ("M H * * *"), not "${job.schedule}"`)
        }
        // The scheduler also fires a singleRun job 30 and 60 minutes later, the same day.
        if (job.singleRun) {
          const [minute, hour] = fields.map(Number)
          if (hour * 60 + minute + 60 >= 24 * 60) fail(`${file}: ${job.route} singleRun needs room for a +60 minute retry before midnight`)
        }
        return { route: job.route, owner: job.owner, schedule: job.schedule, method, freshnessMinutes: job.freshnessMinutes, singleRun: job.singleRun === true, after: job.after ?? null }
      }
      case "external":
        return { route: job.route, owner: job.owner }
      case "unwired":
        if (typeof job.reason !== "string" || !job.reason.trim()) fail(`${file}: ${job.route} is unwired without a reason`)
        return { route: job.route, owner: job.owner, reason: job.reason }
      default:
        return fail(`${file}: ${(job as { route: string }).route} owner must be in-process, external or unwired`)
    }
  }))
}

function simulatedIntegrations(entries: Entry<unknown>[]): Record<string, SimulationRule> {
  const items = objectItems<SimulationRule>("simulated-integrations", entries)
  for (const { file, key, value } of items) {
    const ok =
      typeof value === "object" &&
      value !== null &&
      (value.sandboxEnvVar === null || typeof value.sandboxEnvVar === "string") &&
      Array.isArray(value.sandboxSafeValues) &&
      (value.legacyMessage === undefined || typeof value.legacyMessage === "string")
    if (!ok) fail(`${file}: ${key} must be { sandboxEnvVar, sandboxSafeValues, legacyMessage? }`)
  }
  return Object.fromEntries(items.map((i) => [i.key, i.value]))
}

/** The Prisma UserRole enum, read from the schema folder: a permission names one of these. */
function userRoles(root: string): Set<string> {
  const dir = join(root, "prisma", "schema")
  const schema = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".prisma")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n")
    : ""
  const body = schema.match(/^enum UserRole \{([\s\S]*?)\n\}/m)?.[1]
  if (!body) fail("prisma/schema: enum UserRole not found")
  return new Set(body.split("\n").map((l) => l.replace(/\/\/.*$/, "").trim()).filter(Boolean))
}

/**
 * A permission is a minimum role on the ladder, or an explicit list of the
 * roles granted it (lib/registry/define.ts).
 */
function permissions(root: string, entries: Entry<unknown>[]): Record<string, string | string[]> {
  const roles = userRoles(root)
  const items = objectItems<unknown>("permissions", entries)
  for (const { file, key, value } of items) {
    if (Array.isArray(value)) {
      const ok = value.length > 0 && new Set(value).size === value.length && value.every((r) => typeof r === "string" && roles.has(r))
      if (!ok) fail(`${file}: ${key} must name a UserRole or a non-empty list of distinct UserRoles, got ${JSON.stringify(value)}`)
    } else if (typeof value !== "string" || !roles.has(value)) {
      fail(`${file}: ${key} must name a UserRole, got ${JSON.stringify(value)}`)
    }
  }
  return Object.fromEntries(items.map((i) => [i.key, i.value as string | string[]]))
}

function moduleRules(root: string): string {
  const docs: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next") continue
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name === ".claude.md") docs.push(relative(root, full))
    }
  }
  for (const r of ["lib", "app", "prisma"]) walk(join(root, r))
  const lines = docs.sort().map((doc) => {
    const m = readFileSync(join(root, doc), "utf8").match(/^<!-- summary: (.+?) -->$/m)
    if (!m) fail(`${doc}: needs a "<!-- summary: … -->" line (one line, what the module's rules cover)`)
    return `- \`${doc}\` — ${m[1]}`
  })
  return [
    "<!-- GENERATED by scripts/gen-registries.ts from each .claude.md summary line — do not edit, not committed. -->",
    "# Module rules",
    "",
    "Domain-specific rules live next to the code. Read the module's `.claude.md` before editing inside it.",
    "",
    ...lines,
    "",
  ].join("\n")
}

function tsModule(kind: string, body: string): string {
  return [
    `// GENERATED by scripts/gen-registries.ts from lib/registry/${kind}/*.ts — do not edit, not committed.`,
    `// Add or change an entry in those files, then run: npm run gen:registries`,
    ``,
    body,
    ``,
  ].join("\n")
}

const lit = (v: unknown) => JSON.stringify(v, null, 2)

/** Every output path (relative to the repo root) and its content. */
export async function buildRegistries(root: string = ROOT): Promise<Record<string, string>> {
  const audit = auditActions(await loadKind(root, "audit-actions"))
  const models = tenantScopedModels(await loadKind(root, "tenant-scoped-models"))
  const cron = cronJobs(await loadKind(root, "cron-jobs"))
  const simulated = simulatedIntegrations(await loadKind(root, "simulated-integrations"))
  const perms = permissions(root, await loadKind(root, "permissions"))
  const gen = (f: string) => `lib/registry/generated/${f}`
  return {
    [gen("audit-actions.ts")]: tsModule("audit-actions", `export const AUDIT_ACTIONS = ${lit(audit)} as const`),
    [gen("tenant-scoped-models.ts")]: tsModule("tenant-scoped-models", `export const TENANT_SCOPED_MODELS = ${lit(models)} as const`),
    [gen("cron-jobs.ts")]: tsModule("cron-jobs", `export const CRON_JOBS = ${lit(cron)} as const`),
    [gen("simulated-integrations.ts")]: tsModule("simulated-integrations", `export const SIMULATED_INTEGRATIONS = ${lit(simulated)} as const`),
    [gen("permissions.ts")]: tsModule("permissions", `export const PERMISSIONS = ${lit(perms)} as const`),
    "docs/module-rules.md": moduleRules(root),
  }
}

async function main() {
  const check = process.argv.includes("--check")
  let outputs: Record<string, string>
  try {
    outputs = await buildRegistries()
  } catch (err) {
    if (!(err instanceof RegistryError)) throw err
    console.error(`[gen:registries] FAIL — ${err.message}`)
    process.exit(1)
  }
  const stale: string[] = []
  for (const [rel, content] of Object.entries(outputs)) {
    const abs = join(ROOT, rel)
    const current = existsSync(abs) ? readFileSync(abs, "utf8") : null
    if (current === content) continue
    if (check) {
      stale.push(rel)
      continue
    }
    mkdirSync(dirname(abs), { recursive: true })
    // Write then rename, so a concurrent reader (a parallel test run) never sees half a file.
    const tmp = `${abs}.${process.pid}.tmp`
    writeFileSync(tmp, content, "utf8")
    renameSync(tmp, abs)
    console.log(`[gen:registries] wrote ${rel}`)
  }
  if (check && stale.length) {
    console.error(`[gen:registries] STALE — ${stale.join(", ")}. Run: npm run gen:registries`)
    process.exit(1)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

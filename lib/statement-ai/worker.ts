/**
 * The background worker: the only place this module's model calls run. A
 * route or a statement read enqueues; one job runs at a time per process
 * (the model is shared with the statement reader), and nothing is asked
 * while the tenant has Statement AI off. A job lost to a restart is enqueued
 * again the next time its application is viewed.
 */
import { prisma } from "@/lib/prisma"
import { RECOMPUTE_STATUSES } from "@/lib/credit-checks/recompute"
import { VlmUnavailableError } from "@/lib/statement-analysis/vlm-reader"
import { statementAiEnabled } from "./enabled"
import { generate, missing, planOutputs } from "./generate"
import { modelAvailable } from "./model"
import { runQuestion } from "./ask/run"

export type Job =
  | { type: "application"; tenantId: string; applicationId: string }
  | { type: "question"; tenantId: string; applicationId: string; outputId: string }

/** Jobs one tenant may have waiting: the queue is shared by every tenant on the process. */
export const MAX_WAITING_PER_TENANT = 20

const run = (job: Job) => (job.type === "application" ? runApplication(job) : runQuestion(job.tenantId, job.applicationId, job.outputId))

const keyOf = (job: Job) => `${job.type}:${job.tenantId}:${job.applicationId}${job.type === "question" ? `:${job.outputId}` : ""}`
const waiting = new Map<string, Job>()
const running = new Set<string>()
let queue: Promise<unknown> = Promise.resolve()

/** Fire-and-forget. False when the job was turned away (tenant queue full, or already waiting). */
export function enqueue(job: Job): boolean {
  const key = keyOf(job)
  if (waiting.has(key) || running.has(key)) return false
  if ([...waiting.values()].filter((j) => j.tenantId === job.tenantId).length >= MAX_WAITING_PER_TENANT) {
    console.warn("[statement-ai] job not queued: tenant queue full", { type: job.type })
    return false
  }
  waiting.set(key, job)
  queue = queue
    .then(async () => {
      waiting.delete(key)
      running.add(key)
      if (!(await statementAiEnabled(job.tenantId))) return
      await run(job)
    })
    .catch((err) => {
      if (err instanceof VlmUnavailableError) return
      // Name and code only: an error can echo statement contents.
      console.error("[statement-ai] job failed:", { type: job.type, error: err instanceof Error ? err.name : "unknown", code: (err as { code?: unknown })?.code })
    })
    .finally(() => running.delete(key))
  return true
}

/** Tests only: resolves once every job queued so far has run. */
export function drained(): Promise<unknown> {
  return queue
}

/** The summary and flag explanations the application's current facts lack. */
async function runApplication(job: { tenantId: string; applicationId: string }): Promise<void> {
  if (!modelAvailable()) return
  const planned = await planOutputs(job.tenantId, job.applicationId)
  if (!planned) return
  for (const plan of await missing(job.tenantId, job.applicationId, planned.plans)) {
    await generate(job.tenantId, job.applicationId, plan)
  }
}

/** Generate whatever an application lacks, if the tenant has Statement AI on. */
export function enqueueApplication(tenantId: string, applicationId: string): boolean {
  return enqueue({ type: "application", tenantId, applicationId })
}

/** After a statement read lands (and its flags are recomputed): the client's undecided applications. */
export async function enqueueClientApplications(tenantId: string, clientId: string): Promise<void> {
  if (!(await statementAiEnabled(tenantId))) return
  const apps = await prisma.loanApplication.findMany({ where: { tenantId, clientId, status: { in: [...RECOMPUTE_STATUSES] } }, select: { id: true } })
  for (const app of apps) enqueueApplication(tenantId, app.id)
}

/** Answer an asked question (a PENDING ANSWER row), if the tenant has Statement AI on. */
export function enqueueQuestion(tenantId: string, applicationId: string, outputId: string): boolean {
  return enqueue({ type: "question", tenantId, applicationId, outputId })
}

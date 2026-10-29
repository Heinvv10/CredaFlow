import type { FactDefinition, FactName } from "@/lib/decisioning/facts"
import type { RuleDef, Scorecard } from "@/lib/decisioning/types"

export interface FactOption extends FactDefinition {
  name: FactName
}

export interface RuleSetPayload {
  productId: string | null
  name: string
  effectiveFrom: string
  challengerOnly: boolean
  rules: RuleDef[]
  scorecard: Scorecard | null
}

export interface EnginePayload {
  mode: "OFF" | "SHADOW" | "LIVE"
  channels: string[]
  productIds: string[]
  delegateUserId: string | null
  repaymentMethod: "EFT" | "DEBIT_ORDER"
  challengerVersionId: string | null
  challengerPercent: number
}

export interface VersionRow {
  id: string
  scopeKey: string
  productId: string | null
  version: number
  name: string
  rules: RuleDef[]
  scorecard: Scorecard | null
  effectiveFrom: string
  challengerOnly: boolean
  createdAt: string
}

export interface ChangeRow {
  id: string
  kind: string
  label: string
  title: string
  status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "WITHDRAWN"
  payload: unknown
  decisionNote: string | null
  createdAt: string
  mine: boolean
  canApprove: boolean
}

export interface Overview {
  facts: FactOption[]
  products: { id: string; code: string; name: string }[]
  delegates: { id: string; name: string | null; email: string; role: string }[]
  versions: VersionRow[]
  config: EnginePayload
  requests: ChangeRow[]
  stats: {
    sinceDays: number
    total: number
    byExecution: Record<string, number>
    byVerdict: Record<string, number>
    byRole: Record<string, number>
    latencyMs: { avg: number; p95: number; max: number } | null
  }
  canManage: boolean
  canApprove: boolean
}

export interface ApiResult<T> {
  ok: boolean
  data: T | null
  error: string | null
  problems: string[]
}

/** One JSON call to the settings APIs: failures come back as data, never thrown. */
export async function api<T = unknown>(path: string, method: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = (await res.json().catch(() => null)) as (T & { error?: string; problems?: string[] }) | null
    return { ok: res.ok, data: res.ok ? data : null, error: res.ok ? null : data?.error ?? `Request failed (${res.status})`, problems: data?.problems ?? [] }
  } catch {
    return { ok: false, data: null, error: "Could not reach the server.", problems: [] }
  }
}

export const controlClass =
  "h-9 rounded-md border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-2 text-sm text-[var(--cf-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-brand)]"

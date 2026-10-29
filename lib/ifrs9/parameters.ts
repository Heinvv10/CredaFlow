/**
 * The PD/LGD table. A row is (scope, stage); a scope is the lender default, a
 * contract type or one product, and the most specific scope that has a row for
 * the stage wins. Pure; persistence is in parameters-store.ts.
 */
import { DEFAULT_SCOPE, STAGES, contractScope, productScope, type EclParameter, type Stage } from "./types"

const CONTRACT_TYPES = ["LOAN", "INSTALMENT_SALE", "FINANCE_LEASE", "OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] as const
const PRODUCT_SCOPE = /^PRODUCT:[A-Za-z0-9_-]{1,40}$/

export function resolveParameter(
  rows: readonly EclParameter[],
  loan: { productId: string; contractType: string },
  stage: Stage,
): EclParameter | null {
  for (const scopeKey of [productScope(loan.productId), contractScope(loan.contractType), DEFAULT_SCOPE]) {
    const hit = rows.find((r) => r.scopeKey === scopeKey && r.stage === stage)
    if (hit) return hit
  }
  return null
}

/** Stages the lender default does not cover: a run needs all three, so no loan is ever provisioned at an unset zero. */
export function missingDefaults(rows: readonly EclParameter[]): Stage[] {
  return STAGES.filter((stage) => !rows.some((r) => r.scopeKey === DEFAULT_SCOPE && r.stage === stage))
}

const validScope = (scopeKey: string) =>
  scopeKey === DEFAULT_SCOPE || PRODUCT_SCOPE.test(scopeKey) || (CONTRACT_TYPES as readonly string[]).some((t) => scopeKey === contractScope(t))

const isBps = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10_000

/** Validates a PUT body: `{ parameters: [{ scopeKey, stage, pdBps, lgdBps }] }`. */
export function parseParameterInput(body: unknown): { ok: true; rows: EclParameter[] } | { ok: false; error: string } {
  const list = (body as { parameters?: unknown } | null)?.parameters
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: "The body needs parameters, a non-empty list" }
  const seen = new Set<string>()
  const rows: EclParameter[] = []
  for (const item of list) {
    const { scopeKey, stage, pdBps, lgdBps } = (item ?? {}) as Record<string, unknown>
    if (typeof scopeKey !== "string" || !validScope(scopeKey)) return { ok: false, error: `scopeKey must be DEFAULT, CONTRACT:<contract type> or PRODUCT:<product id>, not ${String(scopeKey)}` }
    if (stage !== 1 && stage !== 2 && stage !== 3) return { ok: false, error: `${scopeKey}: stage must be 1, 2 or 3` }
    if (!isBps(pdBps)) return { ok: false, error: `${scopeKey} stage ${stage}: pdBps must be a whole number of basis points, 0-10000` }
    if (!isBps(lgdBps)) return { ok: false, error: `${scopeKey} stage ${stage}: lgdBps must be a whole number of basis points, 0-10000` }
    if (stage === 3 && pdBps !== 10_000) return { ok: false, error: `${scopeKey} stage 3: pdBps must be 10000, because a Stage 3 loan is credit-impaired (default has happened)` }
    const key = `${scopeKey}|${stage}`
    if (seen.has(key)) return { ok: false, error: `${scopeKey} stage ${stage} is listed twice` }
    seen.add(key)
    rows.push({ scopeKey, stage, pdBps, lgdBps })
  }
  return { ok: true, rows }
}

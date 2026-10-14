/**
 * Experian Normal Search V3 — "Sigma Bureau Enquiry" HTTP client.
 * Spec: Experian Normal Search V3 Interface V1.6 (Nov 2025).
 *
 * Experian is the bureau provider going forward, replacing TransUnion
 * (`lib/integrations/transunion.ts`). Spec-derived, network-free logic
 * (validation, error mapping, request assembly, constants) lives in
 * `experian-spec.ts`; this file is the transport layer.
 *
 * STATUS — request/response shapes mapped from the UAT OpenAPI 3.0.1 Swagger +
 * XSD. The REST path
 * `POST {base}/RequestNewEnquiry`, the snake_case request body, and the
 * `BureauNewBureauEnquiryDataResponse` shape are all confirmed against that spec.
 * NOT YET wired into decisioning, and field NAMES are confirmed but VALUE semantics
 * (which score_type is the SigmaScore, the obligations unit/active-account filter)
 * await the first real UAT report — Experian still owes us test consumer IDs.
 */

import {
  buildRequestPayload,
  classifyExperianError,
  formatRequestTime,
  validateEnquiryInput,
  SIGMA_SCORE_MIN,
  SIGMA_SCORE_MAX,
  type ExperianEnquiryInput,
  type ExperianErrorClass,
} from "./experian-spec"
import { assertSimulationAllowed } from "@/lib/integrations/simulation-guard"
import { loadCredentialPair } from "@/lib/integrations/tenant-credentials"
import { bureauAccounts, type BureauAccount } from "@/lib/integrations/bureau-accounts"

// Re-export the spec surface so `@/lib/integrations/experian` is the one entry point.
export {
  buildRequestPayload,
  classifyExperianError,
  formatRequestTime,
  validateEnquiryInput,
  ENQUIRY_PURPOSE,
  SIGMA_SCORE_MIN,
  SIGMA_SCORE_MAX,
} from "./experian-spec"
export type { ExperianEnquiryInput, ExperianErrorClass, ExperianValidationError } from "./experian-spec"

export interface ExperianResult {
  ok: boolean
  /** Synthetic provider response. Never valid bureau evidence for a decision. */
  simulated?: true
  bureauMatchStatus?: number      // bureau_match.status_code (1=Verified, 3=Deceased)
  deceased?: boolean              // status_code === 3
  score?: number | null           // SigmaScore, or null when unscoreable
  unscoreable?: boolean           // SS present but outside the 480–710 band
  riskGrade?: string              // risk_type
  declineReasons?: string[]       // decline_reason1..5
  adverseInfo?: string[]
  underDebtReview?: boolean
  hasJudgement?: boolean
  hasNotice?: boolean
  totalMonthlyObligations?: number // cents
  /** Every account on the report, for the credit checks; not part of any total. */
  accounts?: BureauAccount[]
  raw?: unknown
  errorCode?: string
  errorClass?: ExperianErrorClass
  retryable?: boolean
  error?: string
}

/**
 * The lender's own Experian account: TenantConfig.experianKey, sealed
 * "username:password". EXPERIAN_USERNAME / EXPERIAN_PASSWORD apply only on a
 * tenant ENV_CREDENTIALS_TENANT_SLUG names (lib/integrations/tenant-credentials.ts). The
 * endpoint settings stay deployment-wide.
 */
async function getExperianConfig(tenantId: string) {
  const creds = await loadCredentialPair(tenantId, "experianKey", {
    id: process.env.EXPERIAN_USERNAME,
    secret: process.env.EXPERIAN_PASSWORD,
  })
  if (!creds) return null
  const { id: username, secret: password } = creds
  const envLabel = (process.env.EXPERIAN_ENV ?? "UAT").toUpperCase()
  const defaultBase =
    envLabel === "PRODUCTION"
      ? "https://apis.experian.co.za:9443/EnquiryService/v3"
      : "https://apis-uat.experian.co.za:9443/EnquiryService/v3"
  return {
    username,
    password,
    envLabel,
    baseUrl: process.env.EXPERIAN_BASE_URL ?? defaultBase,
    timeoutMs: Number(process.env.EXPERIAN_TIMEOUT_MS ?? 20000),
  }
}

function extractErrorCode(body: string): string | undefined {
  try {
    // REST BureauErrorResponse uses snake_case error_code; keep the others as fallbacks.
    const j = JSON.parse(body) as { error_code?: unknown; errorCode?: unknown; ErrorCode?: unknown; BureauResponse?: { ErrorCode?: unknown } }
    const c = j.error_code ?? j.errorCode ?? j.ErrorCode ?? j.BureauResponse?.ErrorCode
    if (typeof c === "string" && c.trim() !== "") return c
  } catch {
    const m = /<ErrorCode>([^<]+)<\/ErrorCode>/.exec(body)
    if (m) return m[1]
  }
  return undefined
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.trim() !== "") return v
  return undefined
}

function extractFromObj(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  return firstString(...keys.map((k) => obj[k]))
}

/** SigmaScore = the score_type "SS" entry at the latest model version. A value
 *  OUTSIDE the 480–710 band (incl. the -1/-3/-4 sentinels below the floor, and
 *  any anomalous value above the ceiling) is "no score", never a numeric score.
 *  Returns score:null + unscoreable:true in that case. */
function pickSigmaScore(
  scores: Array<{ risk_type?: unknown; score?: unknown; score_type?: unknown; version?: unknown; [k: string]: unknown }>
): { score: number | null; unscoreable: boolean; riskGrade?: string; declineReasons: string[] } | undefined {
  const ss = scores
    .filter((s) => typeof s.score_type === "string" && (s.score_type as string).toUpperCase() === "SS")
    .map((s) => ({
      score: typeof s.score === "number" ? s.score : undefined,
      version: typeof s.version === "number" ? s.version : 0,
      riskType: firstString(s.risk_type),
      reasons: [1, 2, 3, 4, 5]
        .map((n) => firstString((s as Record<string, unknown>)[`decline_reason${n}`]))
        .filter((x): x is string => !!x),
    }))
    .filter((s): s is { score: number; version: number; riskType: string | undefined; reasons: string[] } => typeof s.score === "number")
  if (ss.length === 0) return undefined
  const chosen = ss.reduce((a, b) => (b.version > a.version ? b : a))
  const isScore = chosen.score >= SIGMA_SCORE_MIN && chosen.score <= SIGMA_SCORE_MAX
  return {
    score: isScore ? chosen.score : null,
    unscoreable: !isScore,
    riskGrade: chosen.riskType,
    declineReasons: chosen.reasons,
  }
}

/** Maps the REST `BureauNewBureauEnquiryDataResponse` (UAT Swagger) to ExperianResult.
 *  `response_status`/`error_code` own the ok decision — a Failure can arrive on HTTP
 *  200, so never report ok on a payload that names an error. Field names are confirmed
 *  vs the Swagger; value heuristics (SigmaScore selection) await the first real report. */
export function parseEnquiryResult(data: unknown): ExperianResult {
  const d = (data ?? {}) as Record<string, unknown>

  // Success requires an explicit response_status === "Success". A Failure, an
  // error_code, OR a missing/garbled status all fail CLOSED — never risk a
  // false-positive approval on an unparseable body. (The exact success envelope
  // is confirmed against the first real UAT report — pending test consumer IDs.)
  const status = firstString(d.response_status)
  const errCode = extractFromObj(d, "error_code", "errorCode", "ErrorCode")
  if (errCode || status?.toLowerCase() !== "success") {
    // A failure/garbled response with no vendor code is genuinely UNKNOWN — fail
    // closed (non-retryable), never the retryable NS_988 sentinel.
    const code = errCode ?? (status ? "EXPERIAN_FAILURE" : "EXPERIAN_NO_STATUS")
    const { errorClass, retryable } = classifyExperianError(code)
    const desc = extractFromObj(d, "error_description", "errorDescription") ?? code
    return { ok: false, error: `Experian ${status ?? "unparseable response"}: ${desc}`, errorCode: code, errorClass, retryable, raw: data }
  }

  const rd = (d.return_data ?? {}) as Record<string, unknown>
  const bureauMatch = (rd.bureau_match ?? {}) as Record<string, unknown>
  const bureauMatchStatus = typeof bureauMatch.status_code === "number" ? bureauMatch.status_code : undefined
  const deceased = bureauMatchStatus === 3

  const chosen = pickSigmaScore(Array.isArray(rd.bureau_scores) ? rd.bureau_scores : [])

  const adverseInfo = (Array.isArray(rd.adverses) ? rd.adverses : [])
    .map((a) => firstString((a as Record<string, unknown>).adverse_code_desc))
    .filter((s): s is string => !!s)

  const underDebtReview = Array.isArray(rd.debt_restructurings) && rd.debt_restructurings.length > 0
  const hasJudgement = Array.isArray(rd.judgements) && rd.judgements.length > 0
  const hasNotice = Array.isArray(rd.notices) && rd.notices.length > 0

  // Total monthly obligations: sum instalment_amount (WHOLE RANDS) over accounts
  // that are OPEN/CURRENT, then ×100 to the app's cents convention.
  const accounts = Array.isArray(rd.accounts) ? (rd.accounts as Array<Record<string, unknown>>) : []
  const obligationRands = accounts
    .filter((a) => firstString(a.status_code_desc)?.toUpperCase() === "OPEN/CURRENT")
    .reduce((sum, a) => sum + (typeof a.instalment_amount === "number" ? a.instalment_amount : 0), 0)
  const totalMonthlyObligations = accounts.length > 0 ? obligationRands * 100 : undefined
  const accountList = bureauAccounts(accounts, (a) => ({
    subscriber: a.subscriber_name,
    accountType: a.account_type_code_desc,
    instalmentRands: a.instalment_amount,
    status: a.status_code_desc,
  }))

  return {
    ok: true,
    bureauMatchStatus,
    deceased,
    score: chosen?.score ?? null,
    unscoreable: chosen?.unscoreable ?? true,
    riskGrade: chosen?.riskGrade,
    declineReasons: chosen?.declineReasons ?? [],
    adverseInfo,
    underDebtReview,
    hasJudgement,
    hasNotice,
    totalMonthlyObligations,
    accounts: accountList,
    raw: data,
  }
}

/** `tenantId` names whose Experian account makes the enquiry. */
export async function getCreditReport(input: ExperianEnquiryInput, tenantId: string): Promise<ExperianResult> {
  const validation = validateEnquiryInput(input)
  if (!validation.ok) {
    return {
      ok: false,
      error: validation.error,
      errorCode: validation.errorCode,
      errorClass: validation.errorClass,
      retryable: false,
    }
  }

  // Dry-run / unit-test: validate (above) but never spend a billable call.
  if (process.env.NODE_ENV === "test" || process.env.EXPERIAN_DRY_RUN === "true") {
    // Experian is the LIVE bureau path (lib/compliance/bureau-review.ts ->
    // lib/decision/bureau-gate.ts), so a synthetic score here would feed a real
    // lending decision. Fails closed on a deployed build unless EXPERIAN_ENV
    // names a sandbox estate.
    assertSimulationAllowed("experian", true)
    // MOCK: representative in-band SigmaScore. Real shape comes from the layout doc.
    // `simulated` marks it as synthetic for every downstream reader — without it
    // this is indistinguishable from a real bureau result.
    return { ok: true, simulated: true, score: 645, unscoreable: false, riskGrade: "AVERAGE RISK", adverseInfo: [], underDebtReview: false, hasJudgement: false, hasNotice: false, deceased: false }
  }

  const cfg = await getExperianConfig(tenantId)
  if (!cfg) {
    return {
      ok: false,
      error: "Experian not configured for this lender (Settings → Integrations)",
      errorCode: "NOT_CONFIGURED",
      errorClass: "CONFIG",
      retryable: false,
    }
  }

  const payload = buildRequestPayload(input, validation.isoDob, cfg.envLabel, formatRequestTime(new Date()))
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)

  try {
    // Endpoint path + REST body shape are confirmed against the UAT Swagger (see header);
    // UNTESTED: no real UAT response has been received yet.
    const res = await fetch(`${cfg.baseUrl}/RequestNewEnquiry`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    const body = await res.text()

    if (!res.ok) {
      // 400/500 -> BureauErrorResponse with error_code.
      const code = extractErrorCode(body) ?? `HTTP_${res.status}`
      const { errorClass, retryable } = classifyExperianError(code)
      return { ok: false, error: `Experian ${res.status}: ${code}`, errorCode: code, errorClass, retryable, raw: body }
    }

    // 200 -> parseEnquiryResult owns the success/Failure decision (a Failure can
    // arrive on HTTP 200 via response_status).
    let data: unknown = body
    try {
      data = JSON.parse(body)
    } catch {
      // REST returns JSON; a non-JSON 200 is unexpected — pass the raw string through.
    }
    return parseEnquiryResult(data)
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError"
    return {
      ok: false,
      error: aborted ? "Experian request timed out" : e instanceof Error ? e.message : "Experian request failed",
      errorClass: "TRANSIENT",
      retryable: true,
    }
  } finally {
    clearTimeout(timer)
  }
}

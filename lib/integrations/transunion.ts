/**
 * TransUnion integration — Credit bureau checks via REST API
 */

import { loadTenantCredential, splitCredentialPair } from "@/lib/integrations/tenant-credentials"
import { assertSimulationAllowed } from "@/lib/integrations/simulation-guard"
import { bureauAccounts, type BureauAccount } from "@/lib/integrations/bureau-accounts"

interface CreditReportOptions {
  tenantId: string
  idNumber: string
  firstName: string
  lastName: string
}

interface CreditReportResult {
  ok: boolean
  /** Synthetic provider response. Never valid bureau evidence. */
  simulated?: true
  score?: number
  riskGrade?: string
  adverseInfo?: string[]
  totalMonthlyObligations?: number  // in cents — sum of all active credit account instalments
  /** Every account on the report, for the credit checks; not part of any total. */
  accounts?: BureauAccount[]
  raw?: unknown
  error?: string
}

// Token cache, keyed by the tenant's TransUnion client id: one process serves
// several tenants (lib/bureau), and a token minted on one lender's credentials
// must never be spent on another's enquiry.
const cachedTokens = new Map<string, { token: string; expiresAt: number }>()

async function getCredentials(tenantId: string): Promise<{ clientId: string; clientSecret: string } | null> {
  try {
    const pair = splitCredentialPair(await loadTenantCredential(tenantId, "transunionKey"))
    return pair ? { clientId: pair.id, clientSecret: pair.secret } : null
  } catch {
    return null
  }
}

async function getAccessToken(clientId: string, clientSecret: string): Promise<string | null> {
  const now = Date.now()
  const cachedToken = cachedTokens.get(clientId)
  if (cachedToken && cachedToken.expiresAt > now + 30_000) {
    return cachedToken.token
  }

  try {
    const res = await fetch("https://api.transunion.co.za/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    })

    if (!res.ok) return null

    const data = await res.json()
    const expiresIn = (data.expires_in as number) ?? 3600
    const token = data.access_token as string
    cachedTokens.set(clientId, { token, expiresAt: now + expiresIn * 1000 })
    return token
  } catch {
    return null
  }
}

export async function getCreditReport(opts: CreditReportOptions): Promise<CreditReportResult> {
  const dryRun = process.env.NODE_ENV === "test" || process.env.TRANSUNION_DRY_RUN === "true"
  if (dryRun) {
    // Fails closed on a deployed build unless the environment is explicitly
    // declared non-production — a fabricated bureau score must never stand in
    // for a real one on a deployed build.
    assertSimulationAllowed("transunion", true)
    // `simulated` is load-bearing, not decoration: simulation-presentation.ts
    // branches on it, and without it Settings -> Integrations reports a green
    // "Connection successful" for a call that never left the process.
    return { ok: true, score: 650, riskGrade: "C", adverseInfo: [], simulated: true }
  }

  const creds = await getCredentials(opts.tenantId)
  if (!creds) {
    return { ok: false, error: "TransUnion not configured" }
  }

  const token = await getAccessToken(creds.clientId, creds.clientSecret)
  if (!token) {
    return { ok: false, error: "Failed to obtain TransUnion access token" }
  }

  try {
    const res = await fetch("https://api.transunion.co.za/creditreport/consumer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        idNumber: opts.idNumber,
        firstName: opts.firstName,
        lastName: opts.lastName,
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      return { ok: false, error: `TransUnion error ${res.status}: ${errText}` }
    }

    const data = await res.json()
    const score = data.creditScore ?? data.score
    const riskGrade = data.riskGrade ?? data.risk_grade
    // UNTESTED: needs a TransUnion response spec/sample. The field names below are
    // guesses, so a body with no numeric score is refused rather than passed on as ok.
    if (typeof score !== "number") {
      return { ok: false, error: "TransUnion unrecognised response: no numeric score" }
    }
    const adverseInfo: string[] = []

    if (Array.isArray(data.adverseRecords)) {
      for (const rec of data.adverseRecords) {
        adverseInfo.push(String(rec.description ?? rec.type ?? "Adverse record"))
      }
    }

    // Sum all active account monthly instalments — TransUnion may return this as
    // data.totalMonthlyInstalment, data.totalMonthlyObligations, or as a sum of accounts
    let totalMonthlyObligations: number | undefined
    const rawObligation = data.totalMonthlyInstalment ?? data.totalMonthlyObligations
    if (typeof rawObligation === "number" && rawObligation > 0) {
      // TransUnion returns amounts in Rands — convert to cents
      totalMonthlyObligations = Math.round(rawObligation * 100)
    } else if (Array.isArray(data.creditAccounts)) {
      const sum = (data.creditAccounts as Array<{ monthlyInstalment?: number; installment?: number }>)
        .reduce((acc, acct) => acc + (acct.monthlyInstalment ?? acct.installment ?? 0), 0)
      if (sum > 0) totalMonthlyObligations = Math.round(sum * 100)
    }

    // UNTESTED against a live report: field names are the ones the totals
    // above already read, plus the usual names for the creditor and status.
    const accounts = Array.isArray(data.creditAccounts)
      ? bureauAccounts(data.creditAccounts as Array<Record<string, unknown>>, (a) => ({
          subscriber: a.subscriberName ?? a.creditorName ?? a.subscriber,
          accountType: a.accountType,
          instalmentRands: a.monthlyInstalment ?? a.installment,
          status: a.accountStatus ?? a.status,
        }))
      : []

    return {
      ok: true,
      score,
      riskGrade: typeof riskGrade === "string" ? riskGrade : undefined,
      adverseInfo,
      totalMonthlyObligations,
      accounts,
      raw: data,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "TransUnion request failed" }
  }
}

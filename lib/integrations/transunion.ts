/**
 * TransUnion integration — Credit bureau checks via REST API
 */

import { prisma } from "@/lib/prisma"
import { assertSimulationAllowed } from "@/lib/integrations/simulation-guard"

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
  raw?: unknown
  error?: string
}

// Module-level token cache
let cachedToken: { token: string; expiresAt: number } | null = null

async function getCredentials(tenantId: string): Promise<{ clientId: string; clientSecret: string } | null> {
  try {
    const config = await prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { transunionKey: true },
    })
    if (!config?.transunionKey) return null
    const [clientId, clientSecret] = config.transunionKey.split(":")
    if (!clientId || !clientSecret) return null
    return { clientId, clientSecret }
  } catch {
    return null
  }
}

async function getAccessToken(clientId: string, clientSecret: string): Promise<string | null> {
  const now = Date.now()
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
    cachedToken = {
      token: data.access_token as string,
      expiresAt: now + expiresIn * 1000,
    }
    return cachedToken.token
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

    return {
      ok: true,
      score: typeof score === "number" ? score : undefined,
      riskGrade: typeof riskGrade === "string" ? riskGrade : undefined,
      adverseInfo,
      totalMonthlyObligations,
      raw: data,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "TransUnion request failed" }
  }
}

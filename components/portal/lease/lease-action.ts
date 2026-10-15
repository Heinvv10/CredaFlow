// The lease portal actions are POSTs to app/api/portal/asset-finance/leases/[loanId]/…;
// a refusal is a 4xx { error, reason } whose `error` is written for the lessee.

export type LeaseActionOutcome = { ok: true; body: Record<string, unknown> } | { ok: false; message: string }

export const leaseApi = (loanId: string) => `/api/portal/asset-finance/leases/${loanId}`

export async function postLeaseAction(url: string, body: Record<string, unknown>, failure: string): Promise<LeaseActionOutcome> {
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const parsed = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) return { ok: false, message: typeof parsed.error === "string" ? parsed.error : failure }
    return { ok: true, body: parsed }
  } catch {
    return { ok: false, message: `${failure}: check your connection and try again` }
  }
}

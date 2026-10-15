import { PAYOUT_STATUS_LABELS, type PayoutStatus } from "@/lib/payouts/state"

/** POSTs a staff payout action; returns whether it worked and the message to show. */
export async function postAction(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    const json = (await res.json().catch(() => ({}))) as { error?: string; status?: string }
    if (!res.ok) return { ok: false, message: json.error ?? `Failed (${res.status})` }
    const label = PAYOUT_STATUS_LABELS[json.status as PayoutStatus] ?? json.status ?? "done"
    return { ok: true, message: `Done: ${label}` }
  } catch {
    return { ok: false, message: "Network error: nothing was changed by this page. Refresh to see the current state." }
  }
}

"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { formatIsoDate } from "@/lib/asset-finance/format"
import { leaseApi, postLeaseAction } from "./lease-action"

interface Props {
  loanId: string
  /** The SAST calendar day: a lessee reports today's reading only. */
  today: string
  unit: "HOURS" | "KM"
  latest: { readingDate: string; value: number; source: "STAFF" | "PORTAL" | "TELEMATICS" } | null
}

const UNIT_LABEL = { HOURS: "hours", KM: "km" } as const
/** Who took the latest reading: a tracker's is never presented as the lessee's own. */
const SOURCE_LABEL = { TELEMATICS: "from the tracker", STAFF: "recorded by the lessor", PORTAL: "submitted through the portal" } as const

export function LeaseMeterReadingForm({ loanId, today, unit, latest }: Props) {
  const router = useRouter()
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const parsed = /^\d+$/.test(value.trim()) ? Number(value.trim()) : null

  async function submit() {
    if (parsed === null) return
    setBusy(true)
    setMessage(null)
    const outcome = await postLeaseAction(`${leaseApi(loanId)}/readings`, { readingDate: today, value: parsed }, "The reading could not be recorded")
    setBusy(false)
    if (!outcome.ok) return setMessage({ tone: "error", text: outcome.message })
    setValue("")
    setMessage({ tone: "ok", text: "Reading recorded. Thank you." })
    router.refresh()
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="text-[var(--cf-text-muted)]">
        {latest ? `Last reading: ${latest.value.toLocaleString("en-ZA")} ${UNIT_LABEL[unit]} on ${formatIsoDate(latest.readingDate)}, ${SOURCE_LABEL[latest.source]}.` : "No reading has been recorded yet."}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="block text-xs text-[var(--cf-text-muted)]">Today&apos;s meter reading ({UNIT_LABEL[unit]})</span>
          <input
            type="text" inputMode="numeric" value={value} onChange={(event) => setValue(event.target.value)}
            className="mt-1 w-44 rounded-md border border-[var(--cf-border-strong)] bg-[var(--cf-bg)] px-3 py-2 text-[var(--cf-text)]"
          />
        </label>
        <button
          type="button" onClick={submit} disabled={busy || parsed === null}
          className="rounded-md bg-[var(--cf-brand)] px-4 py-2 font-semibold text-[var(--cf-on-brand)] disabled:opacity-50"
        >
          {busy ? "Sending…" : "Submit reading"}
        </button>
      </div>
      {message && (
        <p role="status" className={message.tone === "ok" ? "text-xs text-[var(--cf-success)]" : "text-xs text-[var(--cf-danger)]"}>{message.text}</p>
      )}
    </div>
  )
}

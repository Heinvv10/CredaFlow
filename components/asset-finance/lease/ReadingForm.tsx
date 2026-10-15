"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, TextField } from "@/components/asset-finance/register-form-controls"
import { readingBody } from "@/lib/asset-finance/lease-staff-bodies"
import { useLeaseAction } from "./lease-action"

/** Record a dated meter reading (POST .../readings); it may not be below an earlier reading nor above a later one. */
export function ReadingForm({ url, today, unitLabel }: { url: string; today: string; unitLabel: string }) {
  const [readingDate, setReadingDate] = useState(today)
  const [value, setValue] = useState("")
  const { busy, error, setError, run } = useLeaseAction()

  const submit = async () => {
    const built = readingBody({ readingDate, value })
    if ("error" in built) return setError(built.error)
    if (await run(url, built.body)) setValue("")
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <TextField id="readingDate" label="Reading date" type="date" required max={today} value={readingDate} onChange={setReadingDate} />
        <TextField id="readingValue" label={`Reading (${unitLabel})`} required inputMode="numeric" value={value} onChange={setValue} />
        <Button size="sm" onClick={submit} disabled={busy}>
          {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          {busy ? "Recording…" : "Record reading"}
        </Button>
      </div>
      <FormError message={error} />
    </div>
  )
}

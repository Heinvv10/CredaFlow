"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/toast"

type Props = {
  applicationId: string
  /** When set, submission is known to be impossible: the button renders
   *  disabled with this inline explanation instead of erroring post-click. */
  blockedReason?: string | null
}

export function ApplicationSubmitButton({ applicationId, blockedReason }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function submit() {
    setLoading(true)
    try {
      const res = await fetch(`/api/applications/${applicationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "SUBMITTED" }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(data.error ?? "Failed to submit application")
      toast.success("Application submitted for review")
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to submit application")
    } finally {
      setLoading(false)
    }
  }

  if (blockedReason) {
    return (
      <div>
        <Button type="button" disabled className="w-full">
          Submit for Review
        </Button>
        <p className="mt-1.5 text-xs text-amber-700">{blockedReason}</p>
      </div>
    )
  }

  return (
    <Button type="button" onClick={submit} disabled={loading} className="w-full">
      {loading ? "Submitting…" : "Submit for Review"}
    </Button>
  )
}

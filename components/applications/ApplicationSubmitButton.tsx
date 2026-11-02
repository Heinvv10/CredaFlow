"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { KeyFactsQuote } from "@/components/applications/KeyFactsQuote"
import { toast } from "@/lib/toast"

type Props = {
  applicationId: string
  /** When set, submission is known to be impossible: the button renders
   *  disabled with this inline explanation instead of erroring post-click. */
  blockedReason?: string | null
  /** A key-facts draft: the borrower reads the statement for these terms first (the route refuses otherwise). */
  keyFacts?: boolean
}

export function ApplicationSubmitButton({ applicationId, blockedReason, keyFacts = false }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [keyFactsSha256, setKeyFactsSha256] = useState<string | null>(null)

  async function submit() {
    setLoading(true)
    try {
      const res = await fetch(`/api/applications/${applicationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "SUBMITTED", ...(keyFactsSha256 ? { keyFactsDocumentSha256: keyFactsSha256 } : {}) }),
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
    <div className="space-y-3">
      {keyFacts && (
        <KeyFactsQuote
          endpoint={`/api/applications/${applicationId}/key-facts-quote`}
          intro="Show the borrower what this loan costs on this draft's terms. They read this before it is submitted."
          readLabel="The borrower has read the key facts statement for these terms."
          onRead={setKeyFactsSha256}
        />
      )}
      <Button type="button" onClick={submit} disabled={loading || (keyFacts && !keyFactsSha256)} className="w-full">
        {loading ? "Submitting…" : "Submit for Review"}
      </Button>
    </div>
  )
}

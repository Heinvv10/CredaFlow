"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { FormError, sendJson } from "@/components/asset-finance/register-form-controls"

const DECISIONS = [
  ["APPROVE", "Approve"],
  ["REFER", "Refer"],
  ["DECLINE", "Decline"],
] as const

/**
 * The credit decision (decide_asset_finance). Every decision needs reasons,
 * one per line, each at least 5 characters; the API enforces it again. A deal
 * with exceptions (internal arrears, a bureau check not on record) also needs
 * the reason it is approved despite them; the decision records both.
 */
export function DecidePanel({ dealId, exceptions = [] }: { dealId: string; exceptions?: string[] }) {
  const router = useRouter()
  const [reasons, setReasons] = useState("")
  const [exceptionReason, setExceptionReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  const decide = async (decision: (typeof DECISIONS)[number][0]) => {
    setSaving(decision)
    setError(null)
    const list = reasons.split("\n").map((r) => r.trim()).filter(Boolean)
    const result = await sendJson(`/api/asset-finance/deals/${dealId}/decide`, "POST", {
      decision, reasons: list,
      ...(exceptions.length > 0 && exceptionReason.trim() !== "" ? { exceptionReason, exceptionsShown: exceptions } : {}),
    })
    setSaving(null)
    // Refresh either way: a refused APPROVE on an NCA deal still changes it (REFUSED_NCA).
    if (!result.ok) setError(result.error)
    router.refresh()
  }

  return (
    <div className="space-y-3">
      <FormError message={error} />
      <Label htmlFor="decision-reasons" className="text-xs text-[var(--cf-text-secondary)]">
        Reasons, one per line (required for every decision) *
      </Label>
      <Textarea id="decision-reasons" rows={4} value={reasons} onChange={(e) => setReasons(e.target.value)}
        placeholder={"DSCR 1.8 on audited AFS\nDirectors' bureau records clean"} />
      {exceptions.length > 0 && (
        <>
          <Label htmlFor="exception-reason" className="text-xs text-[var(--cf-text-secondary)]">
            Why approve despite the {exceptions.length === 1 ? "exception" : `${exceptions.length} exceptions`} above (required to approve) *
          </Label>
          <Textarea id="exception-reason" rows={3} value={exceptionReason} onChange={(e) => setExceptionReason(e.target.value)}
            placeholder="e.g. The arrears are under a signed payment plan and the deal is fully secured by the asset and the sureties" />
        </>
      )}
      <div className="flex gap-2">
        {DECISIONS.map(([value, label]) => (
          <Button key={value} size="sm" variant={value === "APPROVE" ? "default" : "outline"} onClick={() => decide(value)}
            disabled={saving !== null}>
            {saving === value && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {label}
          </Button>
        ))}
      </div>
    </div>
  )
}

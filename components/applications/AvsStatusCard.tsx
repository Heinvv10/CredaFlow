"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { CheckCircle, XCircle, AlertTriangle, HelpCircle } from "lucide-react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatDateTime } from "@/lib/utils"
import { toast } from "@/lib/toast"
import { deriveAvsState, type AvsCardState, type AvsLatest } from "./avs-status"

interface Props {
  applicationId: string
  latest: AvsLatest
  currentAccountNumber: string | null
}

const STATE_META: Record<AvsCardState, { label: string; variant: "success" | "danger" | "neutral" | "warning"; Icon: typeof CheckCircle }> = {
  verified: { label: "Verified", variant: "success", Icon: CheckCircle },
  failed: { label: "Failed", variant: "danger", Icon: XCircle },
  not_verified: { label: "Not verified", variant: "neutral", Icon: HelpCircle },
  account_changed: { label: "Applicant or bank details changed — re-verify", variant: "warning", Icon: AlertTriangle },
}

export function AvsStatusCard({ applicationId, latest, currentAccountNumber }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  const state = deriveAvsState(latest, currentAccountNumber)
  const { label, variant, Icon } = STATE_META[state]

  async function runCheck() {
    setLoading(true)
    try {
      const res = await fetch(`/api/applications/${applicationId}/avs-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string; passed?: boolean }
      if (res.ok) {
        toast[body.passed ? "success" : "error"](
          body.passed ? "AVS check passed" : "AVS check failed",
          "The client's bank account details have been re-verified."
        )
        router.refresh()
        return
      }
      toast.error(body.error ?? `AVS check failed (${res.status})`)
    } catch {
      toast.networkError()
    } finally {
      setLoading(false)
    }
  }

  return (
    <DataPanel
      title="Bank Account Verification (AVS)"
      description={currentAccountNumber ? `Account ending ${currentAccountNumber.slice(-4)}` : "No bank account captured"}
      actions={<Badge variant={variant}><Icon className="mr-1 h-3.5 w-3.5" />{label}</Badge>}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--cf-text-secondary)]">
          {latest
            ? `Last checked ${formatDateTime(latest.createdAt)}${!latest.subjectMatches || latest.accountNumber !== currentAccountNumber ? " — details no longer match" : ""}.`
            : "No AVS check has been run for this client yet."}
        </p>
        <Button type="button" variant="outline" onClick={runCheck} disabled={loading}>
          {loading ? "Running…" : "Run AVS check"}
        </Button>
      </div>
    </DataPanel>
  )
}

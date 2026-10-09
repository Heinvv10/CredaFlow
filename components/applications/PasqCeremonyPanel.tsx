"use client"

import { useState } from "react"
import { CheckCircle, FileText, Loader2, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/toast"

interface Props {
  applicationId: string
  /** Digest of the quotation issued for this ceremony, if one has been issued. */
  pasqDocumentSha256: string | null
  /** Whether the consumer has acknowledged that exact quotation. */
  pasqAcknowledged: boolean
  /**
   * `isSmsChannelEnabled()` resolved on the server — this is a client
   * component and cannot read the env var itself. Deliberately REQUIRED, with
   * no default: this panel is currently mounted nowhere, and a required prop
   * makes the compiler force whoever revives it to answer the question rather
   * than shipping an SMS button the route refuses.
   */
  smsEnabled: boolean
  onAcknowledgedChange?: (acknowledged: boolean) => void
}

/**
 * Step 1 of the signing ceremony: give the consumer the quotation and get their
 * acknowledgement (NCA s.92(1)).
 *
 * There is deliberately NO staff control that records the acknowledgement.
 * Staff issue the quotation and send it; only the consumer can confirm they
 * received it, from the portal or from the one-time link. A checkbox here
 * saying "the consumer read it" would be the credit provider attesting to the
 * consumer's own act, which is not an acknowledgement at all.
 */
export function PasqCeremonyPanel({
  applicationId,
  pasqDocumentSha256,
  pasqAcknowledged,
  smsEnabled,
  onAcknowledgedChange,
}: Props) {
  const [sha, setSha] = useState(pasqDocumentSha256)
  // Deliberately setter-less: acknowledgement happens on the CONSUMER'S
  // device (portal or one-time link), so this screen cannot observe it in
  // real time; the panel's copy tells staff to refresh. If live updates are
  // ever wanted, poll the application — do not add a local setter, staff
  // must never be able to flip this state client-side.
  const [acknowledged] = useState(pasqAcknowledged)
  const [issuing, setIssuing] = useState(false)
  const [sending, setSending] = useState<"SMS" | "WHATSAPP" | "EMAIL" | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)

  const issueQuotation = async () => {
    setIssuing(true)
    try {
      const res = await fetch(`/api/applications/${applicationId}/pasq`, { method: "POST" })
      const data = await res.json().catch(() => null) as
        { documentSha256?: string; error?: string } | null
      if (res.ok && data?.documentSha256) {
        setSha(data.documentSha256)
        toast.success("Quotation issued")
        onAcknowledgedChange?.(false)
      } else {
        toast.error("Quotation not issued", data?.error)
      }
    } catch {
      toast.networkError()
    } finally {
      setIssuing(false)
    }
  }

  const sendLink = async (channel: "SMS" | "WHATSAPP" | "EMAIL") => {
    setSending(channel)
    try {
      const res = await fetch(`/api/applications/${applicationId}/pasq/send-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel }),
      })
      const data = await res.json().catch(() => null) as
        { sentTo?: string; simulated?: boolean; error?: string } | null
      if (res.ok) {
        setSentTo(data?.sentTo ?? null)
        toast.success(
          data?.simulated
            ? "Link prepared (messaging is in dry-run — nothing was delivered)"
            : `Acknowledgement link sent to ${data?.sentTo ?? "the consumer"}`,
        )
      } else {
        toast.error("Link not sent", data?.error)
      }
    } catch {
      toast.networkError()
    } finally {
      setSending(null)
    }
  }

  const viewQuotation = () => {
    window.open(`/api/applications/${applicationId}/pasq`, "_blank", "noopener")
  }

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <div>
        <p className="text-sm font-semibold text-[var(--cf-text)]">
          Step 1 — Pre-Agreement Statement &amp; Quotation
        </p>
        <p className="mt-1 text-xs text-[var(--cf-muted)]">
          {acknowledged
            ? `The consumer acknowledged quotation ${sha?.slice(0, 12)}…. You can now generate the agreement.`
            : sha
              ? "Waiting for the consumer to confirm they received this quotation. Send them the link, or ask them to confirm it in the portal."
              : "Issue the quotation for the approved pricing. The agreement cannot be generated until the consumer confirms they received it."}
        </p>
      </div>

      {!sha && (
        <Button onClick={issueQuotation} disabled={issuing}>
          {issuing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
          {issuing ? "Issuing..." : "Issue Quotation"}
        </Button>
      )}

      {sha && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={viewQuotation}>
            <FileText className="h-4 w-4" />View Quotation
          </Button>
          {!acknowledged && (
            <>
              {smsEnabled && (
                <Button
                  variant="outline"
                  onClick={() => sendLink("SMS")}
                  disabled={sending !== null}
                >
                  {sending === "SMS"
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Send className="h-4 w-4" />}
                  {sending === "SMS" ? "Sending..." : "Send link by SMS"}
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => sendLink("WHATSAPP")}
                disabled={sending !== null}
              >
                {sending === "WHATSAPP"
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Send className="h-4 w-4" />}
                {sending === "WHATSAPP" ? "Sending..." : "Send link by WhatsApp"}
              </Button>
              <Button
                variant="outline"
                onClick={() => sendLink("EMAIL")}
                disabled={sending !== null}
              >
                {sending === "EMAIL"
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Send className="h-4 w-4" />}
                {sending === "EMAIL" ? "Sending..." : "Email quotation + link"}
              </Button>
            </>
          )}
        </div>
      )}

      {sentTo && !acknowledged && (
        <p className="text-xs text-[var(--cf-muted)]">
          Sent to {sentTo}. The link is valid for 48 hours and can only be used
          once. Sending again cancels the previous link. Refresh this page after
          the consumer confirms.
        </p>
      )}

      {acknowledged && (
        <p className="flex items-center gap-2 text-xs font-semibold text-[var(--cf-success)]">
          <CheckCircle className="h-4 w-4" />Consumer acknowledgement on record
        </p>
      )}
    </div>
  )
}

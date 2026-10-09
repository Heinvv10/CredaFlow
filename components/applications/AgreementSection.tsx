"use client"

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, CheckCircle, FileText, Loader2, Send } from "lucide-react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/toast"
import { formatZAR } from "@/lib/loan-calculator"
import { portalContinueUrl, portalUrlOrNull } from "@/lib/portal-urls"
import { southAfricanCalendarDate } from "@/lib/compliance/sa-business-days"

interface Props {
  applicationId: string
  status: string
  agreementGeneratedAt: string | null
  agreementSignedAt: string | null
  agreementSignedMethod: string | null
  agreementCountersignedAt: string | null
  agreementDocumentSha256: string | null
  /**
   * The EXECUTED artifact — the only document that carries both signatures.
   * When it exists it is what "Download Agreement" must serve; the signing
   * packet shows BLANK signature rules, which is what staff were handing to
   * consumers as their signed agreement.
   */
  agreementExecutedDocumentId: string | null
  agreementCountersignedByName: string | null
  canCountersign: boolean
  providerSignerName: string
  /** Persisted NCA s.101 initiation-fee election (F-13). */
  initiationFeePayment: "DEFERRED" | "UPFRONT"
  /** Initiation fee in cents — shown so the consumer's election is informed. */
  initiationFee: number
  /** Applied amount in cents — lets each option state the resulting cash advanced. */
  principal: number
  /** Digest of the quotation issued for this ceremony, if one has been issued. */
  pasqDocumentSha256: string | null
  /** Whether the consumer has acknowledged that exact quotation. */
  pasqAcknowledged: boolean
  /**
   * Payout-grade composite-KYC blockers. Approval runs the lenient gate and
   * agreement generation runs the strict one, so an application can be
   * APPROVED while `POST /agreement` still refuses. Preparing the packet in
   * that state issues a real quotation and then fails, leaving staff holding a
   * PASQ with no agreement behind it. Required, not optional: an absent prop
   * would silently read as "not blocked", which is the failure being fixed.
   */
  signingKycBlockers: { label: string; detail: string }[]
  /** Consumer's email — /portal/continue matches it against `reference`. */
  clientEmail: string
  /** Application reference — proves the email belongs to a real application. */
  reference: string
}

export function AgreementSection({
  applicationId,
  status,
  agreementGeneratedAt,
  agreementSignedAt,
  agreementSignedMethod,
  agreementCountersignedAt,
  agreementDocumentSha256,
  agreementExecutedDocumentId,
  agreementCountersignedByName,
  canCountersign,
  providerSignerName,
  initiationFeePayment,
  initiationFee,
  principal,
  pasqDocumentSha256,
  signingKycBlockers,
  clientEmail,
  reference,
}: Props) {
  const router = useRouter()
  const [generating, setGenerating] = useState(false)
  const [signing, setSigning] = useState(false)
  const [savingElection, setSavingElection] = useState(false)
  const [genAt, setGenAt] = useState(agreementGeneratedAt)
  const [signedAt, setSignedAt] = useState(agreementSignedAt)
  const [signedMethod, setSignedMethod] = useState(agreementSignedMethod)
  const [countersignedAt, setCountersignedAt] = useState(agreementCountersignedAt)
  // The digest of the document currently on screen — echoed at signing so a
  // regeneration can never be signed over unseen bytes.
  const [agreementSha, setAgreementSha] = useState(agreementDocumentSha256)
  const [countersignedByName, setCountersignedByName] = useState(agreementCountersignedByName)
  const [countersigning, setCountersigning] = useState(false)
  const [emailing, setEmailing] = useState(false)
  const [providerSignature, setProviderSignature] = useState(providerSignerName)
  const [providerAttestation, setProviderAttestation] = useState(false)
  const [branchConsumerSignature, setBranchConsumerSignature] = useState<string | null>(null)
  const [branchWitnessAttestation, setBranchWitnessAttestation] = useState(false)
  const [returnedPacketFile, setReturnedPacketFile] = useState<File | null>(null)
  const [returnedPacketAttestation, setReturnedPacketAttestation] = useState(false)
  // The SAST date the consumer signed the paper, which is not necessarily the
  // day the branch scans it back. Defaults to today so the common same-day case
  // needs no thought.
  const [returnedPacketSignedOn, setReturnedPacketSignedOn] = useState(
    () => southAfricanCalendarDate(new Date()),
  )
  const [returnedPacket, setReturnedPacket] = useState<{
    documentId: string
    contentSha256: string
  } | null>(null)
  const [recordingReturnedPacket, setRecordingReturnedPacket] = useState(false)
  const [feePayment, setFeePayment] = useState<"DEFERRED" | "UPFRONT">(initiationFeePayment)
  // Survives the toast. Set when the agreement call fails after the quotation
  // has already been issued — the state that put a signed PASQ in front of two
  // live consumers on 2026-08-04.
  const [prepFailure, setPrepFailure] = useState<{
    // Whether a quotation actually reached the client record before the failure.
    // The banner states this as fact about a legal document, so it is tracked
    // rather than assumed: the catch below is reachable from the PASQ call too.
    quotationIssued: boolean
    error: string
    remediation: string | null
  } | null>(null)
  const [pasqSha, setPasqSha] = useState(pasqDocumentSha256)

  const handleGenerate = async () => {
    // The disabled button is presentation only. Refuse here too, so a stale
    // render can never fire the request that mints an unfollowable quotation.
    if (signingKycBlockers.length > 0) return
    setGenerating(true)
    setPrepFailure(null)
    // Declared outside the try so the catch can tell "the quotation call itself
    // failed" (nothing issued) from "the agreement call failed" (a real
    // quotation now exists on the client record).
    let currentPasqSha = pasqSha
    try {
      if (!currentPasqSha) {
        const pasqRes = await fetch(`/api/applications/${applicationId}/pasq`, {
          method: "POST",
        })
        const pasq = await pasqRes.json().catch(() => null) as {
          documentSha256?: string
          error?: string
        } | null
        if (!pasqRes.ok || !pasq?.documentSha256) {
          toast.error("Packet preparation failed", pasq?.error ?? "The PASQ could not be prepared.")
          return
        }
        currentPasqSha = pasq.documentSha256
        setPasqSha(currentPasqSha)
      }
      const res = await fetch(`/api/applications/${applicationId}/agreement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initiationFeePayment: feePayment }),
      })
      if (res.ok) {
        // The signer must echo the digest of the document on screen — a
        // fresh generation in this same sitting must teach it to this page,
        // or the very next branch-signature would 409 as "replaced".
        const doc = await res.json().catch(() => null) as { contentSha256?: string } | null
        if (doc?.contentSha256) setAgreementSha(doc.contentSha256)
        setGenAt(new Date().toISOString())
        toast.agreement.generated()
      } else {
        const data = await res.json().catch(() => null) as {
          error?: string
          remediation?: string
        } | null
        // A toast disappears; the quotation this call left behind does not.
        // Keep the failure on the panel so the half-prepared state is visible
        // for as long as it lasts.
        setPrepFailure({
          quotationIssued: true,
          error: data?.error ?? "The credit agreement could not be prepared.",
          remediation: data?.remediation ?? null,
        })
        toast.error("Generation failed", data?.error)
      }
    } catch {
      setPrepFailure({
        quotationIssued: Boolean(currentPasqSha),
        error: "The credit agreement could not be prepared — the request did not complete.",
        remediation: null,
      })
      toast.networkError()
    } finally {
      setGenerating(false)
    }
  }

  const [regenerating, setRegenerating] = useState(false)
  const handleRegenerate = async () => {
    if (!confirm(
      "Replace the unsigned agreement with a freshly generated document? "
      + "The current draft is retired and the client signs the new one. "
      + "The client's quotation acknowledgement is unaffected. "
      + "If a signing page is already open anywhere, it must be refreshed "
      + "before signing.",
    )) return
    setRegenerating(true)
    try {
      const res = await fetch(`/api/applications/${applicationId}/agreement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regenerate: true }),
      })
      if (res.ok) {
        const doc = await res.json().catch(() => null) as { contentSha256?: string } | null
        if (doc?.contentSha256) setAgreementSha(doc.contentSha256)
        // A signature drawn or attested against the SUPERSEDED document must
        // never survive into the new one.
        setBranchConsumerSignature(null)
        setBranchWitnessAttestation(false)
        setGenAt(new Date().toISOString())
        toast.success("Agreement regenerated", "The client must review and sign the NEW document. Any open signing page needs a refresh.")
      } else {
        const data = await res.json().catch(() => null) as { error?: string } | null
        toast.error("Regeneration failed", data?.error)
      }
    } catch {
      toast.networkError()
    } finally {
      setRegenerating(false)
    }
  }

  const handleSaveElection = async () => {
    setSavingElection(true)
    try {
      const res = await fetch(`/api/applications/${applicationId}/agreement`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initiationFeePayment: feePayment }),
      })
      if (res.ok) {
        toast.success("Initiation-fee election saved")
      } else {
        const data = await res.json() as { error?: string }
        toast.error("Election not saved", data.error)
      }
    } catch {
      toast.networkError()
    } finally {
      setSavingElection(false)
    }
  }

  const handleSignBranch = async () => {
    setSigning(true)
    try {
      const res = await fetch(`/api/applications/${applicationId}/agreement/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "branch",
          signature: branchConsumerSignature,
          attestation: branchWitnessAttestation,
          agreementDocumentSha256: agreementSha,
          pasqDocumentSha256: pasqSha,
        }),
      })
      if (res.ok) {
        setSignedAt(new Date().toISOString())
        setSignedMethod("branch")
        toast.agreement.signed()
      } else {
        toast.agreement.signFailed()
      }
    } catch {
      toast.networkError()
    } finally {
      setSigning(false)
    }
  }

  const handleRecordReturnedPacket = async () => {
    if (!returnedPacketFile || !returnedPacketAttestation) return
    setRecordingReturnedPacket(true)
    try {
      let uploaded = returnedPacket
      if (!uploaded) {
        const form = new FormData()
        form.set("file", returnedPacketFile)
        form.set("attestation", "true")
        const uploadRes = await fetch(
          `/api/applications/${applicationId}/signing-packet`,
          { method: "POST", body: form },
        )
        const uploadData = await uploadRes.json().catch(() => null) as {
          documentId?: string
          contentSha256?: string
          error?: string
        } | null
        if (
          !uploadRes.ok
          || !uploadData?.documentId
          || !uploadData.contentSha256
        ) {
          toast.error("Signed packet not uploaded", uploadData?.error)
          return
        }
        uploaded = {
          documentId: uploadData.documentId,
          contentSha256: uploadData.contentSha256,
        }
        setReturnedPacket(uploaded)
      }

      const res = await fetch(`/api/applications/${applicationId}/agreement/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "branch",
          attestation: true,
          agreementDocumentSha256: agreementSha,
          pasqDocumentSha256: pasqSha,
          signedPacketDocumentId: uploaded.documentId,
          signedPacketSha256: uploaded.contentSha256,
          signedOn: returnedPacketSignedOn,
        }),
      })
      const data = await res.json().catch(() => null) as { error?: string } | null
      if (!res.ok) {
        toast.error("Signed packet not recorded", data?.error)
        return
      }
      setSignedAt(new Date().toISOString())
      setSignedMethod("returned PDF")
      toast.success("Signed PASQ + agreement recorded")
    } catch {
      toast.networkError()
    } finally {
      setRecordingReturnedPacket(false)
    }
  }

  // The executed artifact once it exists, otherwise the signing packet. The
  // packet is the PASQ + the UNSIGNED agreement — correct before signature,
  // and a blank-signature document afterwards.
  const viewAgreement = () => window.open(
    agreementExecutedDocumentId
      ? `/api/documents/${agreementExecutedDocumentId}/view?download=1`
      : `/api/applications/${applicationId}/signing-packet`,
    "_blank",
  )

  const handleEmailAgreement = async () => {
    setEmailing(true)
    try {
      const res = await fetch(`/api/applications/${applicationId}/agreement/email`, { method: "POST" })
      const data = await res.json().catch(() => null) as { sentTo?: string; error?: string } | null
      if (res.ok) {
        toast.success(`Agreement emailed to ${data?.sentTo ?? "the client"}`)
      } else {
        toast.error("Agreement not emailed", data?.error)
      }
    } catch {
      toast.networkError()
    } finally {
      setEmailing(false)
    }
  }

  const handleEmailSigningPacket = async () => {
    setEmailing(true)
    try {
      const res = await fetch(
        `/api/applications/${applicationId}/signing-packet/email`,
        { method: "POST" },
      )
      const data = await res.json().catch(() => null) as {
        sentTo?: string
        error?: string
      } | null
      if (res.ok) {
        toast.success(`Signing packet emailed to ${data?.sentTo ?? "the client"}`)
      } else {
        toast.error("Signing packet not emailed", data?.error)
      }
    } catch {
      toast.networkError()
    } finally {
      setEmailing(false)
    }
  }

  const handleCountersign = async () => {
    setCountersigning(true)
    try {
      const res = await fetch(`/api/applications/${applicationId}/agreement/countersign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature: providerSignature, attestation: providerAttestation }),
      })
      const data = await res.json() as {
        error?: string
        countersignedAt?: string
        countersignedByName?: string
      }
      if (!res.ok) {
        toast.error("Countersign failed", data.error)
        return
      }
      setCountersignedAt(data.countersignedAt ?? new Date().toISOString())
      setCountersignedByName(data.countersignedByName ?? providerSignerName)
      toast.success("Provider countersignature recorded")
      router.refresh()
    } catch {
      toast.networkError()
    } finally {
      setCountersigning(false)
    }
  }

  if (status === "UNDER_REVIEW") {
    return (
      <DataPanel title="Initiation Fee Election">
        <StatusNotice tone="info" icon={<AlertCircle className="h-5 w-5" />}>
          Record the consumer&apos;s election before approval so affordability, the agreement, and disbursement use one pricing record.
        </StatusNotice>
        <FeeElection
          feePayment={feePayment}
          initiationFee={initiationFee}
          principal={principal}
          onChange={setFeePayment}
        />
        <div className="mt-4">
          <Button onClick={handleSaveElection} disabled={savingElection}>
            {savingElection ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
            {savingElection ? "Saving..." : "Save election before approval"}
          </Button>
        </div>
      </DataPanel>
    )
  }

  if (status !== "APPROVED" && !genAt && !signedAt) return null

  if (signedAt) {
    // Explicit timeZone: without it this resolves to the JS runtime's local
    // zone, which differs between the server (SSR, typically UTC) and the
    // browser (SAST) — a text mismatch that trips React hydration (#418).
    const date = new Date(signedAt).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Johannesburg" })
    const countersignDate = countersignedAt
      ? new Date(countersignedAt).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Johannesburg" })
      : null
    return (
      <DataPanel title="Credit Agreement">
        <StatusNotice tone={countersignedAt ? "success" : "warning"} icon={countersignedAt ? <CheckCircle className="h-5 w-5" /> : <AlertCircle className="h-5 w-5" />}>
          {countersignedAt
            ? `Consumer signed by ${signedMethod} on ${date}; provider countersigned by ${countersignedByName ?? "authorised representative"} on ${countersignDate}.`
            : `Consumer signed by ${signedMethod} on ${date}. Provider countersignature is still required before disbursement.`}
        </StatusNotice>
        {!countersignedAt && canCountersign && (
          <div className="mt-4 space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
            <div>
              <label htmlFor="provider-signature" className="text-sm font-semibold text-[var(--cf-text)]">
                Provider representative signature
              </label>
              <input
                id="provider-signature"
                value={providerSignature}
                onChange={(event) => setProviderSignature(event.target.value)}
                className="mt-1 w-full rounded-md border border-[var(--cf-border-subtle)] cf-signature-pad px-3 py-2 text-sm"
                autoComplete="name"
              />
            </div>
            <label className="flex items-start gap-2 text-sm text-[var(--cf-text)]">
              <input
                type="checkbox"
                className="mt-0.5 accent-[var(--cf-brand)]"
                checked={providerAttestation}
                onChange={(event) => setProviderAttestation(event.target.checked)}
              />
              <span>I have reviewed the exact consumer-signed agreement and countersign it for the credit provider.</span>
            </label>
            <Button
              onClick={handleCountersign}
              disabled={countersigning || !providerAttestation || providerSignature.trim().length === 0}
            >
              {countersigning ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
              {countersigning ? "Countersigning..." : "Countersign Agreement"}
            </Button>
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" onClick={viewAgreement}>
            <FileText className="h-4 w-4" />Download Agreement
          </Button>
          {countersignedAt && (
            <Button variant="outline" onClick={handleEmailAgreement} disabled={emailing}>
              <Send className="h-4 w-4" />
              {emailing ? "Emailing..." : "Email copy to client"}
            </Button>
          )}
        </div>
      </DataPanel>
    )
  }

  if (genAt) {
    return (
      <DataPanel title="Credit Agreement">
        <StatusNotice tone="warning" icon={<AlertCircle className="h-5 w-5" />}>
          Agreement generated and awaiting signature
        </StatusNotice>
        <div className="mt-4 space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <div>
            <p className="text-sm font-semibold text-[var(--cf-text)]">
              Consumer signature in branch
            </p>
            <p className="mt-1 text-xs text-[var(--cf-muted)]">
              The consumer must draw this signature after reviewing the PASQ first and the credit agreement second in the exact packet above.
            </p>
          </div>
          <BranchSignatureCapture key={genAt ?? "initial"} onChange={setBranchConsumerSignature} />
          <label className="flex items-start gap-2 text-sm text-[var(--cf-text)]">
            <input
              type="checkbox"
              className="mt-0.5 accent-[var(--cf-brand)]"
              checked={branchWitnessAttestation}
              onChange={(event) => setBranchWitnessAttestation(event.target.checked)}
            />
            <span>I witnessed the consumer review the exact PASQ and credit agreement in this packet, then draw the signature shown above.</span>
          </label>
          <Button
            onClick={handleSignBranch}
            disabled={signing || !branchConsumerSignature || !branchWitnessAttestation}
          >
            {signing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
            {signing ? "Recording signature..." : "Record Witnessed Branch Signature"}
          </Button>
        </div>
        <div className="mt-4 space-y-3 rounded-lg border border-[var(--cf-border-subtle)] p-4">
          <div>
            <p className="text-sm font-semibold text-[var(--cf-text)]">
              Returned signed PDF
            </p>
            <p className="mt-1 text-xs text-[var(--cf-muted)]">
              Use this when the client signed the complete PASQ + credit agreement packet on paper or in a PDF app and returned it.
            </p>
          </div>
          <input
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => {
              setReturnedPacketFile(event.target.files?.[0] ?? null)
              setReturnedPacket(null)
            }}
            className="block w-full text-sm text-[var(--cf-text)]"
          />
          <label className="block text-sm text-[var(--cf-text)]">
            <span className="font-semibold">Date the client signed</span>
            <input
              type="date"
              value={returnedPacketSignedOn}
              max={southAfricanCalendarDate(new Date())}
              onChange={(event) => setReturnedPacketSignedOn(event.target.value)}
              className="mt-1 block rounded border border-[var(--cf-border-subtle)] bg-transparent px-2 py-1 text-sm text-[var(--cf-text)]"
            />
            <span className="mt-1 block text-xs text-[var(--cf-muted)]">
              The date on the paper, not today&apos;s date — they can differ when a
              packet is returned the next day.
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-[var(--cf-text)]">
            <input
              type="checkbox"
              className="mt-0.5 accent-[var(--cf-brand)]"
              checked={returnedPacketAttestation}
              onChange={(event) => setReturnedPacketAttestation(event.target.checked)}
            />
            <span>I checked that this returned PDF contains the complete PASQ first and credit agreement second, and that the client signed the packet.</span>
          </label>
          <Button
            variant="outline"
            onClick={handleRecordReturnedPacket}
            disabled={
              recordingReturnedPacket
              || !returnedPacketFile
              || !returnedPacketAttestation
            }
          >
            {recordingReturnedPacket
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <CheckCircle className="h-4 w-4" />}
            {recordingReturnedPacket
              ? "Recording signed packet..."
              : "Upload and Record Signed Packet"}
          </Button>
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button variant="outline" onClick={viewAgreement}>
            <FileText className="h-4 w-4" />View PASQ + Agreement
          </Button>
          <Button variant="outline" onClick={() => {
            // NOT window.location.origin: staff are always on the app host, so
            // that produced an app.* link for a consumer-facing surface. It
            // resolves (both services run the same image), which is exactly why
            // it went unnoticed. /portal/continue also handles the customer who
            // has not registered yet — a bare deep link sends them to a login
            // page with no way forward.
            const url = portalUrlOrNull(() => portalContinueUrl(clientEmail, reference, `/portal/agreement/${applicationId}`))
            if (!url) {
              toast.error("The client portal URL is not configured for this deployment.")
              return
            }
            navigator.clipboard.writeText(url)
            toast.copied()
          }}>
            <Send className="h-4 w-4" />Copy Portal Signing Link
          </Button>
          <Button variant="outline" onClick={handleEmailSigningPacket} disabled={emailing}>
            <Send className="h-4 w-4" />
            {emailing ? "Emailing..." : "Email PASQ + Agreement"}
          </Button>
          <Button variant="outline" onClick={handleRegenerate} disabled={regenerating}>
            {regenerating
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <FileText className="h-4 w-4" />}
            {regenerating ? "Regenerating..." : "Regenerate Agreement"}
          </Button>
        </div>
      </DataPanel>
    )
  }

  return (
    <DataPanel title="Credit Agreement">
      <StatusNotice tone="info" icon={<AlertCircle className="h-5 w-5" />}>
        Prepare the PASQ and credit agreement as one signing packet. The client reviews and signs both in one sitting, in office or by returning the signed PDF.
      </StatusNotice>

      {signingKycBlockers.length > 0 && (
        <div className="mt-4">
          <StatusNotice tone="danger" icon={<AlertCircle className="h-5 w-5" />}>
            <span className="block font-semibold">
              Identity verification must be completed before the packet can be prepared.
            </span>
            <span className="mt-1 block">
              Preparing it now would issue a quotation that no credit agreement can follow — agreement
              generation applies a stricter identity check than approval does.
            </span>
            {signingKycBlockers.map((blocker) => (
              <span key={blocker.label} className="mt-2 block">
                <span className="font-medium">{blocker.label}</span> — {blocker.detail}
              </span>
            ))}
          </StatusNotice>
        </div>
      )}

      {prepFailure && (
        <div className="mt-4">
          <StatusNotice tone="danger" icon={<AlertCircle className="h-5 w-5" />}>
            <span className="block font-semibold">
              {prepFailure.quotationIssued
                ? "The quotation was issued but the credit agreement was not prepared."
                : "No quotation was issued and the credit agreement was not prepared."}
            </span>
            <span className="mt-1 block">{prepFailure.error}</span>
            {prepFailure.remediation && (
              <span className="mt-1 block">{prepFailure.remediation}</span>
            )}
            <span className="mt-2 block font-medium">
              {prepFailure.quotationIssued
                ? "Do not send the quotation to the client for signature — it is not the credit agreement. Resolve the blocker above, then prepare the packet again."
                : "Nothing was sent to the client. Resolve the blocker above, then prepare the packet again."}
            </span>
          </StatusNotice>
        </div>
      )}

      {/* NCA s.101 initiation-fee election. The consumer must be given the
          option to pay the (interest-free) initiation fee upfront or to have it
          collected through the schedule. The choice is baked into the agreement
          the consumer signs (F-13). */}
      <FeeElection
        feePayment={feePayment}
        initiationFee={initiationFee}
        principal={principal}
        onChange={setFeePayment}
        disabled
      />

      <div className="mt-4">
        <p className="mb-2 text-sm font-semibold text-[var(--cf-text)]">
          PASQ + Credit Agreement
        </p>
        <Button
          onClick={handleGenerate}
          disabled={generating || signingKycBlockers.length > 0}
        >
          {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
          {generating ? "Preparing..." : "Prepare PASQ + Credit Agreement"}
        </Button>
      </div>
    </DataPanel>
  )
}

function BranchSignatureCapture({
  onChange,
}: {
  onChange: (signature: string | null) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawingRef = useRef(false)
  const inkRef = useRef(false)

  const position = (
    event: ReactPointerEvent<HTMLCanvasElement>,
    canvas: HTMLCanvasElement,
  ) => {
    const bounds = canvas.getBoundingClientRect()
    return {
      x: (event.clientX - bounds.left) * (canvas.width / bounds.width),
      y: (event.clientY - bounds.top) * (canvas.height / bounds.height),
    }
  }

  const start = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context) return
    const point = position(event, canvas)
    canvas.setPointerCapture(event.pointerId)
    context.beginPath()
    context.moveTo(point.x, point.y)
    context.lineWidth = 2.5
    context.lineCap = "round"
    context.lineJoin = "round"
    context.strokeStyle = "#1f2937"
    drawingRef.current = true
    inkRef.current = false
  }

  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context || !drawingRef.current) return
    const point = position(event, canvas)
    context.lineTo(point.x, point.y)
    context.stroke()
    inkRef.current = true
  }

  const finish = () => {
    const canvas = canvasRef.current
    if (!canvas || !drawingRef.current) return
    drawingRef.current = false
    onChange(inkRef.current ? canvas.toDataURL("image/png") : null)
  }

  const clear = () => {
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    drawingRef.current = false
    inkRef.current = false
    onChange(null)
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={720}
        height={180}
        className="h-36 w-full touch-none rounded-md border border-[var(--cf-border-subtle)] bg-white"
        aria-label="Consumer branch signature pad"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={finish}
        onPointerLeave={finish}
      />
      <button
        type="button"
        onClick={clear}
        className="mt-2 text-xs font-medium text-[var(--cf-muted)] underline"
      >
        Clear signature
      </button>
    </div>
  )
}

function FeeElection({
  feePayment,
  initiationFee,
  principal,
  onChange,
  disabled = false,
}: {
  feePayment: "DEFERRED" | "UPFRONT"
  initiationFee: number
  principal: number
  onChange: (value: "DEFERRED" | "UPFRONT") => void
  disabled?: boolean
}) {
  return (
    <div className="mt-4 rounded-lg border border-[var(--cf-border-subtle)] p-4">
      <p className="text-sm font-semibold text-[var(--cf-text)]">Initiation fee ({formatZAR(initiationFee)}) — consumer election</p>
      <p className="mt-0.5 text-xs text-[var(--cf-text-secondary)]">
        The initiation fee is interest-free either way (NCR Circular 15 of 2016).
      </p>
      <div className="mt-3 space-y-2">
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="feePayment"
            className="mt-0.5 accent-[var(--cf-brand)]"
            checked={feePayment === "DEFERRED"}
            disabled={disabled}
            onChange={() => onChange("DEFERRED")}
          />
          <span className="text-sm text-[var(--cf-text)]">
            Add to the repayment schedule — full amount advanced to the consumer
            {/* State the cash outcome in rands: this election decides what
                actually reaches the consumer's account, and "less the fee" was
                being read as an abstraction rather than a number. */}
            <span className="mt-0.5 block text-xs text-[var(--cf-text-secondary)]">
              Consumer receives the full {formatZAR(principal)}.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="feePayment"
            className="mt-0.5 accent-[var(--cf-brand)]"
            checked={feePayment === "UPFRONT"}
            disabled={disabled}
            onChange={() => onChange("UPFRONT")}
          />
          <span className="text-sm text-[var(--cf-text)]">
            Deduct from the amount advanced
            <span className="mt-0.5 block text-xs text-[var(--cf-text-secondary)]">
              Consumer receives {formatZAR(Math.max(0, principal - initiationFee))} — {formatZAR(initiationFee)} less than applied for.
            </span>
          </span>
        </label>
      </div>
      {disabled && (
        <p className="mt-3 text-xs text-[var(--cf-text-muted)]">
          Locked by the approval snapshot. Return the application to review to change this election.
        </p>
      )}
    </div>
  )
}

function StatusNotice({ tone, icon, children }: { tone: "success" | "warning" | "info" | "danger"; icon: React.ReactNode; children: React.ReactNode }) {
  const toneClass = {
    success: "border-[rgba(63,191,127,0.28)] bg-[rgba(63,191,127,0.08)] text-[var(--cf-success)]",
    warning: "border-[rgba(217,154,58,0.28)] bg-[rgba(217,154,58,0.08)] text-[var(--cf-warning)]",
    info: "border-[rgba(111,159,203,0.28)] bg-[rgba(111,159,203,0.08)] text-[var(--cf-info)]",
    danger: "border-[rgba(228,119,104,0.32)] bg-[rgba(228,119,104,0.10)] text-[var(--cf-danger)]",
  }[tone]
  return (
    <div className={`flex items-center gap-3 rounded-lg border p-4 ${toneClass}`}>
      {icon}
      <p className="font-medium">{children}</p>
    </div>
  )
}

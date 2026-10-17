"use client"

import { useMemo, useState, useRef, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Camera, Copy, FileText, Upload, X } from "lucide-react"
import { Progress } from "@/components/ui/progress"
import {
  DOC_TYPE_LABELS,
  UPLOADABLE_DOC_TYPES,
  mayBeMisfiledSignedAgreement,
} from "@/lib/document-types"
import { SelfieCapture } from "./SelfieCapture"
import { toast } from "@/lib/toast"

/**
 * Staff-only ways forward when the client cannot take a live selfie on this
 * device. Deliberately optional and absent on the portal: `kycHref` points at a
 * staff-app tab a consumer cannot open, and telling one to "ask an admin" is a
 * dead end in their own document list.
 */
export interface SelfieAlternatives {
  /** /portal/continue link that lands the client on their own document list;
   * null when the deployment has no portal URL configured (button hidden). */
  portalUrl: string | null
  /** Client detail page, KYC tab, anchored at the identity-verification card. */
  kycHref: string
  /**
   * Whether the KYC tab is actually showing the in-person verification form
   * right now — `inPersonKycVerificationOffered`, derived on the server.
   *
   * The selfie step opens as soon as the ID copy is extracted, but the form
   * needs EVERY core document, so without this the pointer sends staff to a
   * page where the control they were promised is not rendered.
   */
  inPersonOffered: boolean
}

/**
 * The application whose signed credit agreement is still outstanding, if any.
 * Staff-only, and shown when "Other" is picked — that is where a returned
 * signed packet lands when the person holding it cannot find a better option,
 * and a loose client document binds to nothing.
 */
export interface SignedAgreementReturn {
  /** Application reference, so staff can tell it is the right one. */
  reference: string
  /** The application page, anchored at its Credit Agreement panel. */
  href: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  clientId: string
  onUploadComplete: () => void
  allowedTypes?: string[]
  initialDocType?: string
  hasIdDocument?: boolean
  selfieAlternatives?: SelfieAlternatives
  signedAgreementReturn?: SignedAgreementReturn
  /** Shown when the camera will not open: the portal's "Continue on your phone". */
  selfieFallback?: ReactNode
}

export function UploadDialog({
  open,
  onOpenChange,
  clientId,
  onUploadComplete,
  allowedTypes,
  initialDocType,
  hasIdDocument = false,
  selfieAlternatives,
  signedAgreementReturn,
  selfieFallback,
}: Props) {
  const selfiePortalUrl = selfieAlternatives?.portalUrl ?? null
  const [docType, setDocType] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [capturedSelfie, setCapturedSelfie] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState("")
  // The upload succeeded, but the file is not what staff may think it is. This
  // holds the dialog open instead of closing behind a toast — the whole point
  // is that a vanishing confirmation lets a signed agreement sit
  // unrecorded against a loan.
  const [postUploadWarning, setPostUploadWarning] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  // Defaults to what may actually be uploaded, NOT every label. DOC_TYPE_LABELS
  // includes the system-generated types (credit agreement, debit mandate, Form
  // 20) so they render wherever documents are listed — offering them here made
  // the picker present three options the server rejects with 400 "Invalid
  // docType", two of which are exactly what someone holding a signed packet
  // would choose.
  const types = useMemo(
    () => allowedTypes || [...UPLOADABLE_DOC_TYPES],
    [allowedTypes],
  )

  // Reset the form when the dialog opens, or when what it was opened with
  // changes. Adjusted during render (a stored previous value) rather than in an
  // effect, so the stale form is never painted. `null` makes the first render
  // count as a change, so a dialog mounted already open still starts reset.
  const [prevReset, setPrevReset] = useState<{
    open: boolean
    initialDocType: string | undefined
    types: string[]
  } | null>(null)
  if (
    prevReset === null
    || prevReset.open !== open
    || prevReset.initialDocType !== initialDocType
    || prevReset.types !== types
  ) {
    setPrevReset({ open, initialDocType, types })
    if (open) {
      setDocType(initialDocType && types.includes(initialDocType) ? initialDocType : "")
      setFile(null)
      setCapturedSelfie(null)
      setError("")
      setProgress(0)
      // Not the post-upload warning: this reset also fires on a new `types`
      // identity while the dialog is open, which must not wipe a warning the
      // user has not read yet. The warning is cleared on open, below.
    }
  }

  // Deliberately its OWN tracked value, keyed on `open` alone.
  //
  // Clearing: Radix closes this dialog via its X button, Escape and overlay
  // click, all of which call onOpenChange directly and bypass "I understand" —
  // so without an on-open clear, a stale warning naming a DIFFERENT
  // application reappears before a file has even been chosen.
  //
  // Why not in the reset above: that one also depends on `types`, which
  // derives from the `allowedTypes` prop. A caller passing an inline array
  // (`allowedTypes={["ID_COPY","OTHER"]}`) gives it a new identity on every
  // parent render, re-firing the reset WHILE the dialog is open and wiping a
  // warning the user has not read yet — silently undoing this fix from the
  // other direction. No current call site does that, but nothing stops one.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    setPostUploadWarning("")
  }

  const handleDocTypeChange = (value: string) => {
    setDocType(value)
    setFile(null)
    setCapturedSelfie(null)
    setError("")
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setError("")

    const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"]
    if (!allowed.includes(f.type)) {
      setError("File type not allowed. Use JPG, PNG, WebP or PDF.")
      return
    }
    if (f.size > 10 * 1024 * 1024) {
      setError("File too large. Maximum 10MB.")
      return
    }
    setFile(f)
  }

  const handleUpload = async () => {
    const isSelfie = docType === "SELFIE"
    const uploadFile = isSelfie ? capturedSelfie : file
    if (!uploadFile || !docType) return
    setUploading(true)
    setProgress(20)
    setError("")

    try {
      const fd = new FormData()

      if (isSelfie) {
        fd.append("image", uploadFile)
        fd.append("clientId", clientId)
      } else {
        fd.append("file", uploadFile)
        fd.append("docType", docType)
        fd.append("clientId", clientId)
      }

      setProgress(50)
      const endpoint = isSelfie ? "/api/documents/selfie" : "/api/documents"
      const res = await fetch(endpoint, { method: "POST", body: fd })
      setProgress(90)

      if (!res.ok) {
        const body = await res.json()
        const msg = body.error || "Upload failed"
        setError(msg)
        toast.error(msg)
        return
      }

      const uploaded = await res.json().catch(() => null) as {
        signedAgreementWarning?: { message?: string }
      } | null

      setProgress(100)
      setFile(null)
      setCapturedSelfie(null)
      setDocType("")
      toast.document.uploaded(DOC_TYPE_LABELS[docType] || docType)
      onUploadComplete()
      const warning = uploaded?.signedAgreementWarning?.message
      if (warning) {
        // Deliberately does NOT close: staff must read this before moving on.
        setPostUploadWarning(warning)
        return
      }
      onOpenChange(false)
    } catch {
      setError("Upload failed. Please try again.")
      toast.networkError()
    } finally {
      setUploading(false)
      setProgress(0)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const f = e.dataTransfer.files[0]
    if (f) {
      const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"]
      if (!allowed.includes(f.type)) {
        setError("File type not allowed. Use JPG, PNG, WebP or PDF.")
        return
      }
      if (f.size > 10 * 1024 * 1024) {
        setError("File too large. Maximum 10MB.")
        return
      }
      setFile(f)
      setError("")
    }
  }

  const selectedLabel = docType ? DOC_TYPE_LABELS[docType] || docType : "document"
  const isSelfie = docType === "SELFIE"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isSelfie ? "Take selfie" : initialDocType ? `Upload ${selectedLabel}` : "Upload document"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-xl border border-[var(--cf-border-subtle)] bg-[rgba(255,255,255,0.04)] p-3 text-sm text-[var(--cf-text-muted)]">
            {isSelfie ? (
              <span className="flex gap-2"><Camera className="mt-0.5 h-4 w-4 shrink-0" /> Take a live selfie from this checklist step. We compare it to your ID document.</span>
            ) : (
              <span className="flex gap-2"><FileText className="mt-0.5 h-4 w-4 shrink-0" /> Choose the document type, then upload a clear photo or PDF.</span>
            )}
          </div>

          {/* Doc type */}
          <div>
            <Label>Document Type</Label>
            <Select value={docType} onValueChange={handleDocTypeChange}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select type..." />
              </SelectTrigger>
              <SelectContent>
                {types.map((t) => (
                  <SelectItem key={t} value={t}>
                    {DOC_TYPE_LABELS[t] || t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* The one thing this dialog must not silently accept. The upload
              route warns AFTER the fact (signedAgreementWarning); by then the
              file is stored and the person has moved on. Said here, before the
              upload, while the choice is still theirs. Shown for every type
              the route would warn about, not just "Other" — someone holding a
              signed packet reaches for whichever row looks closest. Core KYC
              types are excluded, because a banner on every upload is a banner
              nobody reads. */}
          {signedAgreementReturn && mayBeMisfiledSignedAgreement(docType) && (
            <div className="rounded-lg border border-[rgba(217,154,58,0.40)] bg-[rgba(217,154,58,0.10)] p-3 text-sm">
              <p className="font-semibold text-[var(--cf-warning)]">
                Is this the client&rsquo;s signed credit agreement?
              </p>
              <p className="mt-1 text-[var(--cf-warning)]">
                Do not file it here. Application {signedAgreementReturn.reference}{" "}
                is still waiting for its signed agreement, and a document uploaded
                on this screen is not recorded as one &mdash; the application stays
                undisbursable. Record it on the{" "}
                <a
                  href={signedAgreementReturn.href}
                  className="font-medium underline"
                >
                  Credit Agreement panel
                </a>{" "}
                with &ldquo;Upload and Record Signed Packet&rdquo;.
              </p>
            </div>
          )}

          {/* Selfie camera capture or file drop zone */}
          {docType === "SELFIE" ? (
            <div className="space-y-3">
              {!hasIdDocument && (
                <div className="rounded-lg border border-[rgba(79,70,229,0.35)] bg-[rgba(79,70,229,0.12)] p-3 text-sm font-medium text-[var(--cf-warning)]">
                  Upload your ID document first, then come back to this Selfie verification row to take the selfie.
                </div>
              )}
              <SelfieCapture
                onCapture={(f) => setCapturedSelfie(f)}
                disabled={!hasIdDocument}
                fallback={selfieFallback}
              />
              {/* A greyed-out camera with no way forward is where staff give up
                  and file the photo as "Other" — which records nothing. Both
                  routes out of that are elsewhere in the app, so name them
                  here. NOT a file-upload fallback: an emailed photo cannot
                  carry the liveness and face-match evidence this step exists to
                  produce, and accepting one would record a biometric pass that
                  nobody performed. */}
              {/* Plain <a>, not next/link, and that is load-bearing. This link
                  only changes `?tab=` on the page it is already on; the client
                  page's Radix Tabs is uncontrolled (`defaultValue`), so a
                  client-side navigation updates the URL and leaves Documents
                  selected — the link appears to do nothing. A full load lets
                  the server re-resolve the tab, and only then does the
                  #kyc-identity-verification anchor exist to scroll to. Same
                  reason app/(dashboard)/settings/whatsapp uses a bare <a> for
                  its own ?tab= deep link. */}
              {selfieAlternatives && (
                <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[rgba(255,255,255,0.035)] p-3 text-sm text-[var(--cf-text-muted)]">
                  <p className="font-medium text-[var(--cf-text)]">
                    Client not in front of you?
                  </p>
                  {selfiePortalUrl && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-2"
                        onClick={async () => {
                          // Awaited, and the toast is gated on it: a denied
                          // clipboard write (insecure context, no permission, lost
                          // focus) otherwise reports "Copied" over an empty
                          // clipboard, and staff send the client nothing.
                          try {
                            await navigator.clipboard.writeText(selfiePortalUrl)
                            // Clears a previous copy failure: leaving it up puts a
                            // red "could not copy" banner beside a "Copied" toast.
                            setError("")
                            toast.copied()
                          } catch {
                            setError(
                              `Could not copy to the clipboard. The link is: ${selfiePortalUrl}`,
                            )
                          }
                        }}
                      >
                        <Copy className="h-3 w-3" />
                        Copy portal selfie link
                      </Button>
                      <p className="mt-2">
                        Send it to them and they take the selfie on their own phone.
                      </p>
                    </>
                  )}
                  <p className="mt-2">
                    {selfieAlternatives.inPersonOffered ? (
                      <>
                        {selfiePortalUrl ? "Or, if" : "If"} you have already compared the client to their ID
                        face to face, an ADMIN can record that on the{" "}
                        <a
                          href={selfieAlternatives.kycHref}
                          className="font-medium text-[var(--cf-brand)] underline"
                        >
                          KYC tab
                        </a>
                        . An in-person verification substitutes for the selfie; a
                        photo filed as &ldquo;Other&rdquo; does not.
                      </>
                    ) : (
                      <>
                        An ADMIN can also verify identity in person instead of a
                        selfie, but that is not on offer for this client right
                        now &mdash; the{" "}
                        <a
                          href={selfieAlternatives.kycHref}
                          className="font-medium text-[var(--cf-brand)] underline"
                        >
                          KYC tab
                        </a>{" "}
                        shows where this client stands. Filing a photo as
                        &ldquo;Other&rdquo; is not a substitute either way.
                      </>
                    )}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              className="rounded-xl border-2 border-dashed border-[var(--cf-border-subtle)] bg-[rgba(255,255,255,0.035)] p-6 text-center transition-colors hover:border-[var(--cf-brand)] cursor-pointer"
              onClick={() => inputRef.current?.click()}
            >
              <input
                ref={inputRef}
                type="file"
                className="hidden"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={handleFileSelect}
              />
              {file ? (
                <div className="flex items-center justify-between">
                  <div className="text-left">
                    <p className="text-sm font-medium text-[var(--cf-text)]">{file.name}</p>
                    <p className="text-xs text-[var(--cf-text-muted)]">
                      {(file.size / (1024 * 1024)).toFixed(2)} MB
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      setFile(null)
                    }}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <>
                  <Upload className="h-8 w-8 text-[var(--cf-text-muted)] mx-auto mb-2" />
                  <p className="text-sm font-medium text-[var(--cf-text)]">
                    Tap to browse or drag a file here
                  </p>
                  <p className="text-xs text-[var(--cf-text-muted)] mt-1">
                    JPG, PNG, WebP or PDF — Max 10MB
                  </p>
                </>
              )}
            </div>
          )}

          {/* Error */}
          {error && <p className="rounded-lg border border-[rgba(208,92,75,0.35)] bg-[rgba(208,92,75,0.10)] p-3 text-sm font-medium text-[var(--cf-danger)]">{error}</p>}

          {/* Uploaded, but not what it may look like. Stays until dismissed. */}
          {postUploadWarning && (
            <div className="rounded-lg border border-[rgba(217,154,58,0.40)] bg-[rgba(217,154,58,0.10)] p-3">
              <p className="text-sm font-semibold text-[var(--cf-warning)]">
                Uploaded — but not recorded as the signed agreement
              </p>
              <p className="mt-1 text-sm font-medium text-[var(--cf-warning)]">
                {postUploadWarning}
              </p>
              <Button
                variant="outline"
                className="mt-3"
                onClick={() => {
                  setPostUploadWarning("")
                  onOpenChange(false)
                }}
              >
                I understand
              </Button>
            </div>
          )}

          {/* Progress */}
          {uploading && <Progress value={progress} className="h-2" />}

          {/* Upload button */}
          <Button
            className="w-full"
            disabled={(docType === "SELFIE" ? !capturedSelfie : !file) || !docType || uploading}
            onClick={handleUpload}
          >
            {uploading ? "Uploading..." : "Upload"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

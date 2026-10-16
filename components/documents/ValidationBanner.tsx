"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AlertTriangle, CheckCircle, ChevronDown, ChevronUp } from "lucide-react"
import type { ValidationResult, ValidationMismatch } from "@/lib/document-types"

/** The doc types whose extracted fields the disbursement gate actually reads. */
const BANKING_EVIDENCE_DOC_TYPES = new Set(["BANK_STATEMENT"])

/**
 * The validation props are absent when the viewer may not see the document's
 * lending read (lib/security/client-redaction.ts); the banner then shows only
 * the extraction status, never a verdict.
 */
interface Props {
  validationResult?: ValidationResult | null
  validationMismatch?: boolean
  validationScore?: number | null
  extractionStatus: string
  extractionError: string | null
  /** Present when extraction SUCCEEDED, even if validation later failed; undefined when withheld. */
  hasExtractedData?: boolean
  docType: string
  verified: boolean
  docId: string
  onOverride?: (docId: string, note: string) => void
}

export function ValidationBanner({
  validationResult,
  validationMismatch,
  validationScore,
  extractionStatus,
  extractionError,
  hasExtractedData,
  docType,
  verified,
  docId,
  onOverride,
}: Props) {
  const [warningsExpanded, setWarningsExpanded] = useState(false)
  const [overrideNote, setOverrideNote] = useState("")
  const [showOverride, setShowOverride] = useState(false)

  if (extractionStatus === "pending" || extractionStatus === "processing") {
    return (
      <div className="flex items-center gap-2 p-2 bg-blue-50 rounded text-xs text-blue-700">
        <div className="h-3 w-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        Analysing document...
      </div>
    )
  }

  // Extraction failed, so there is no validationResult and every branch below
  // renders nothing — which is how a document that no machine could read came
  // to look identical to a clean one, get ticked "Verified" by hand, and then
  // be refused by the disbursement gate with no visible cause. Warn, but do
  // not block: a human who can open the file may still legitimately verify it.
  // `extractionResult != null` means extraction SUCCEEDED and validation threw
  // afterwards — the route stores the data and still marks the status failed.
  // Claiming "could not be read" there would be false, and the password hint
  // would send staff after the wrong remedy.
  // Withheld (undefined): whether the read succeeded is not this viewer's to know.
  if (hasExtractedData === undefined) return null

  if (extractionStatus === "failed" && !hasExtractedData) {
    const passwordProtected = /password/i.test(extractionError ?? "")
    return (
      <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <div className="flex-1 space-y-1">
            <p className="text-sm font-medium text-amber-800">
              Could not be read automatically — no extracted data
            </p>
            <p className="text-xs text-amber-700">
              {passwordProtected
                ? "This PDF is password-protected. Re-upload an unlocked copy so it can be read."
                : "Automatic extraction failed for this document."}
            </p>
            {/* Only the banking documents feed the payout-account match, so
                only they get that warning. On a selfie or an ID copy it would
                be nonsense. */}
            {BANKING_EVIDENCE_DOC_TYPES.has(docType) && (
              <p className="text-xs text-amber-700">
                Marking it verified will not satisfy the disbursement checks —
                those match the payout account against data read from the
                document itself.
              </p>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (!validationResult || validationScore == null) return null

  const criticalMismatches = validationResult.mismatches.filter(
    (m: ValidationMismatch) => m.severity === "critical"
  )
  const warnings = validationResult.mismatches.filter(
    (m: ValidationMismatch) => m.severity === "warning"
  )

  // Critical mismatch — RED banner
  if (validationMismatch && !verified) {
    return (
      <div className="space-y-2">
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
            <div className="flex-1 space-y-1">
              <p className="text-sm font-medium text-red-800">
                Document Mismatch — Extracted data does not match client record
              </p>
              {criticalMismatches.map((m: ValidationMismatch, i: number) => (
                <p key={i} className="text-xs text-red-700">
                  {m.label}: Document shows &quot;{m.documentValue}&quot;, client record has &quot;{m.recordValue}&quot;
                </p>
              ))}
              {warnings.length > 0 && (
                <p className="text-xs text-red-600 mt-1">
                  + {warnings.length} warning(s)
                </p>
              )}
            </div>
          </div>
          {onOverride && (
            <div className="mt-2">
              {!showOverride ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs text-red-700 border-red-300"
                  onClick={() => setShowOverride(true)}
                >
                  Override &amp; Accept
                </Button>
              ) : (
                <div className="space-y-2">
                  <textarea
                    className="w-full text-xs border border-red-300 rounded p-2 bg-white"
                    placeholder="Explain why this mismatch is acceptable (required)..."
                    value={overrideNote}
                    onChange={(e) => setOverrideNote(e.target.value)}
                    rows={2}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="text-xs bg-red-600 hover:bg-red-700"
                      disabled={overrideNote.trim().length < 5}
                      onClick={() => onOverride(docId, overrideNote.trim())}
                    >
                      Confirm Override
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs"
                      onClick={() => { setShowOverride(false); setOverrideNote("") }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  // Warnings only — ORANGE badge
  if (warnings.length > 0 && !validationMismatch) {
    return (
      <div className="space-y-1">
        <button
          className="flex items-center gap-1.5"
          onClick={() => setWarningsExpanded(!warningsExpanded)}
        >
          <Badge className="bg-orange-100 text-orange-800 text-xs">
            <AlertTriangle className="h-3 w-3 mr-1" />
            {validationScore}% match — review warnings
          </Badge>
          {warningsExpanded ? (
            <ChevronUp className="h-3 w-3 text-orange-600" />
          ) : (
            <ChevronDown className="h-3 w-3 text-orange-600" />
          )}
        </button>
        {warningsExpanded && (
          <div className="p-2 bg-orange-50 rounded text-xs space-y-1">
            {warnings.map((m: ValidationMismatch, i: number) => (
              <p key={i} className="text-orange-700">{m.message}</p>
            ))}
          </div>
        )}
      </div>
    )
  }

  // All good — GREEN badge
  if (validationScore !== null && !validationMismatch) {
    return (
      <Badge className="bg-green-100 text-green-800 text-xs">
        <CheckCircle className="h-3 w-3 mr-1" />
        Verified Match ({validationScore}%)
      </Badge>
    )
  }

  return null
}

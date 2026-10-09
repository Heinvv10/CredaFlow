"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

interface KycDocument {
  id: string
  docType: string
  fileName: string
  verified: boolean
  fileSize: number | null
  createdAt: Date
}

interface Props {
  clientId: string
  kycStatus: string
  documents: KycDocument[]
}

const DOC_TYPES = [
  { key: "ID_COPY", label: "Certified ID Copy" },
  { key: "PROOF_OF_ADDRESS", label: "Proof of Address" },
  { key: "PAYSLIP", label: "Latest Payslip" },
  { key: "BANK_STATEMENT", label: "3-Month Bank Statement" },
  { key: "SELFIE", label: "Selfie / Photo" },
] as const

const CORE_TYPES = ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"]

const KYC_STATUS_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  PENDING:  { bg: "#F3F4F6", color: "#6B7280", label: "PENDING" },
  VERIFIED: { bg: "#D1FAE5", color: "#065F46", label: "VERIFIED" },
  FAILED:   { bg: "#FEE2E2", color: "#991B1B", label: "FAILED" },
  EXPIRED:  { bg: "#FEF3C7", color: "#92400E", label: "EXPIRED" },
}

function formatFileSize(bytes: number | null): string {
  if (!bytes) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function KycDocumentsSection({ clientId, kycStatus, documents }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [rejectDocId, setRejectDocId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  const kycStyle = KYC_STATUS_STYLES[kycStatus] ?? KYC_STATUS_STYLES.PENDING

  const verifiedCoreCount = CORE_TYPES.filter((type) =>
    documents.some((d) => d.docType === type && d.verified)
  ).length

  async function handleVerify(docId: string, verified: boolean, reason?: string) {
    setLoading((prev) => ({ ...prev, [docId]: true }))
    setError(null)
    try {
      const response = await fetch(`/api/clients/${clientId}/documents/${docId}/verify`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verified, rejectReason: reason }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        setError((data as { error?: string }).error ?? "Failed to update document")
        return
      }
      router.refresh()
    } finally {
      setLoading((prev) => ({ ...prev, [docId]: false }))
    }
  }

  function handleRejectConfirm(docId: string) {
    handleVerify(docId, false, rejectReason).then(() => {
      setRejectDocId(null)
      setRejectReason("")
    })
  }

  return (
    <div style={{ background: "#fff", borderRadius: 8, boxShadow: "0 1px 3px rgba(0,0,0,0.1)", padding: 24 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h3 style={{ fontSize: 18, fontWeight: 600, color: "#111827", margin: 0 }}>KYC Documents</h3>
          <p style={{ fontSize: 13, color: "#6B7280", marginTop: 4 }}>
            {verifiedCoreCount} of 4 core docs verified
          </p>
        </div>
        <span style={{
          background: kycStyle.bg,
          color: kycStyle.color,
          padding: "4px 12px",
          borderRadius: 9999,
          fontSize: 12,
          fontWeight: 600,
        }}>
          {kycStyle.label}
        </span>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{ background: "#FEE2E2", color: "#991B1B", padding: "8px 12px", borderRadius: 4, marginBottom: 12, fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Document rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {DOC_TYPES.map(({ key, label }) => {
          const doc = documents.find((d) => d.docType === key)
          const isLoading = doc ? loading[doc.id] : false

          let statusBg = "#F3F4F6"
          let statusColor = "#6B7280"
          let statusText = "NOT UPLOADED"

          if (doc) {
            if (doc.verified) {
              statusBg = "#D1FAE5"; statusColor = "#065F46"; statusText = "VERIFIED"
            } else if (doc.verified === false && doc.fileName) {
              // uploaded but not yet verified — check if it was rejected (we don't have verificationNote here,
              // so we treat unverified + uploaded as UPLOADED by default)
              statusBg = "#DBEAFE"; statusColor = "#1E40AF"; statusText = "UPLOADED"
            }
          }

          return (
            <div key={key} style={{
              display: "flex",
              alignItems: "center",
              padding: "12px 16px",
              background: "#F9FAFB",
              borderRadius: 6,
              gap: 12,
              flexWrap: "wrap",
            }}>
              {/* Label + filename */}
              <div style={{ flex: 1, minWidth: 160 }}>
                <p style={{ fontWeight: 500, fontSize: 14, color: "#111827", margin: 0 }}>{label}</p>
                {doc && (
                  <p style={{ fontSize: 12, color: "#6B7280", margin: "2px 0 0" }}>
                    {doc.fileName}{doc.fileSize ? ` · ${formatFileSize(doc.fileSize)}` : ""}
                  </p>
                )}
              </div>

              {/* Status badge */}
              <span style={{
                background: statusBg,
                color: statusColor,
                padding: "3px 10px",
                borderRadius: 9999,
                fontSize: 11,
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}>
                {statusText}
              </span>

              {/* Action buttons */}
              {doc && !doc.verified && (
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => handleVerify(doc.id, true)}
                    disabled={isLoading}
                    style={{
                      background: "#16A085",
                      color: "#fff",
                      border: "none",
                      borderRadius: 4,
                      padding: "5px 14px",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: isLoading ? "not-allowed" : "pointer",
                      opacity: isLoading ? 0.6 : 1,
                    }}
                  >
                    {isLoading ? "..." : "Verify"}
                  </button>
                  <button
                    onClick={() => setRejectDocId(doc.id)}
                    disabled={isLoading}
                    style={{
                      background: "#E74C3C",
                      color: "#fff",
                      border: "none",
                      borderRadius: 4,
                      padding: "5px 14px",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: isLoading ? "not-allowed" : "pointer",
                      opacity: isLoading ? 0.6 : 1,
                    }}
                  >
                    Reject
                  </button>
                </div>
              )}

              {doc && doc.verified && (
                <button
                  onClick={() => setRejectDocId(doc.id)}
                  disabled={isLoading}
                  style={{
                    background: "transparent",
                    color: "#E74C3C",
                    border: "1px solid #E74C3C",
                    borderRadius: 4,
                    padding: "4px 12px",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: isLoading ? "not-allowed" : "pointer",
                  }}
                >
                  Revoke
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Reject / Revoke modal */}
      {rejectDocId && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50,
        }}>
          <div style={{ background: "#fff", borderRadius: 8, padding: 24, width: 400, maxWidth: "90vw" }}>
            <h4 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 600 }}>Reject Document</h4>
            <p style={{ fontSize: 13, color: "#6B7280", marginBottom: 12 }}>
              Provide a reason for rejection (optional).
            </p>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Rejection reason..."
              style={{
                width: "100%", minHeight: 80, padding: 8, border: "1px solid #D1D5DB",
                borderRadius: 4, fontSize: 13, resize: "vertical", boxSizing: "border-box",
              }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
              <button
                onClick={() => { setRejectDocId(null); setRejectReason("") }}
                style={{
                  background: "#F3F4F6", color: "#374151", border: "none",
                  borderRadius: 4, padding: "7px 16px", fontSize: 13, cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleRejectConfirm(rejectDocId)}
                disabled={loading[rejectDocId]}
                style={{
                  background: "#E74C3C", color: "#fff", border: "none",
                  borderRadius: 4, padding: "7px 16px", fontSize: 13,
                  fontWeight: 600, cursor: loading[rejectDocId] ? "not-allowed" : "pointer",
                  opacity: loading[rejectDocId] ? 0.6 : 1,
                }}
              >
                Confirm Reject
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

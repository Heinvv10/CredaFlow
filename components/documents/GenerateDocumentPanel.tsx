"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { FileText, PenLine, Loader2 } from "lucide-react"
import { toast } from "@/lib/toast"

export type SigningMethod = "NONE" | "NATIVE" | "SIGNUM"

export type CustomTemplateOption = {
  key: string
  name: string
  category: string | null
  signingMethod: SigningMethod
}

interface GeneratedDoc {
  id: string
  name: string
  signingMethod: SigningMethod
  signatureStatus: "idle" | "sending" | "sent" | "error"
  signatureError: string | null
}

interface Props {
  clientId: string
  loanId?: string
  applicationId?: string
  templates: CustomTemplateOption[]
  /** Called after a document is successfully generated — lets the caller
   * refresh the client's document list (e.g. re-mount `DocumentsTab`). */
  onGenerated?: () => void
}

/**
 * "Generate document" control (Task 18) — picks one of the tenant's CUSTOM
 * templates (SYSTEM documents are generated via their own dedicated routes,
 * not this one — see `app/api/documents/generate/route.ts`), posts to
 * `/api/documents/generate`, and surfaces the result. A 422 response means
 * the template still has unresolved `{{token}}` placeholders for this
 * client/loan/application — shown as an explicit missing-fields list, not a
 * generic error. Once generated, a document whose template requires
 * signature (`signingMethod !== "NONE"`) gets a "Send for signature" action
 * wired to `POST /api/documents/[id]/request-signature`.
 */
export function GenerateDocumentPanel({ clientId, loanId, applicationId, templates, onGenerated }: Props) {
  const [selectedKey, setSelectedKey] = useState<string>(templates[0]?.key ?? "")
  const [generating, setGenerating] = useState(false)
  const [missingTokens, setMissingTokens] = useState<string[] | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [generatedDocs, setGeneratedDocs] = useState<GeneratedDoc[]>([])

  const handleGenerate = async () => {
    const template = templates.find((t) => t.key === selectedKey)
    if (!template) return

    setGenerating(true)
    setMissingTokens(null)
    setErrorMsg(null)
    try {
      const res = await fetch("/api/documents/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateKey: template.key, clientId, loanId, applicationId }),
      })
      const body = await res.json()

      if (res.ok) {
        setGeneratedDocs((prev) => [
          {
            id: body.clientDocumentId,
            name: template.name,
            signingMethod: template.signingMethod,
            signatureStatus: "idle",
            signatureError: null,
          },
          ...prev,
        ])
        toast.success("Document generated", `${template.name} is ready.`)
        onGenerated?.()
      } else if (res.status === 422) {
        setMissingTokens(body.missing ?? [])
      } else {
        setErrorMsg(body.error ?? "Failed to generate document")
      }
    } catch {
      setErrorMsg("Failed to generate document")
    } finally {
      setGenerating(false)
    }
  }

  const handleSendForSignature = async (docId: string) => {
    setGeneratedDocs((prev) =>
      prev.map((d) => (d.id === docId ? { ...d, signatureStatus: "sending", signatureError: null } : d))
    )
    try {
      const res = await fetch(`/api/documents/${docId}/request-signature`, { method: "POST" })
      const body = await res.json()
      if (res.ok) {
        setGeneratedDocs((prev) =>
          prev.map((d) => (d.id === docId ? { ...d, signatureStatus: "sent" } : d))
        )
        toast.success("Sent for signature")
      } else {
        const message = body.error ?? "Could not send for signature"
        setGeneratedDocs((prev) =>
          prev.map((d) => (d.id === docId ? { ...d, signatureStatus: "error", signatureError: message } : d))
        )
        toast.error("Could not send for signature", message)
      }
    } catch {
      setGeneratedDocs((prev) =>
        prev.map((d) =>
          d.id === docId ? { ...d, signatureStatus: "error", signatureError: "Could not send for signature" } : d
        )
      )
    }
  }

  if (templates.length === 0) {
    return (
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Generate Document</h3>
        <p className="text-sm text-gray-500">No published custom document templates are available for this client.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-gray-900">Generate Document</h3>
      <div className="flex items-center gap-3">
        <Select value={selectedKey} onValueChange={setSelectedKey}>
          <SelectTrigger className="w-72">
            <SelectValue placeholder="Select a template" />
          </SelectTrigger>
          <SelectContent>
            {templates.map((t) => (
              <SelectItem key={t.key} value={t.key}>
                {t.name}{t.category ? ` — ${t.category}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={handleGenerate} disabled={generating || !selectedKey}>
          {generating ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <FileText className="h-4 w-4 mr-2" />
          )}
          Generate
        </Button>
      </div>

      {missingTokens && missingTokens.length > 0 && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          Cannot generate — missing: {missingTokens.join(", ")}
        </div>
      )}
      {errorMsg && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{errorMsg}</div>
      )}

      {generatedDocs.length > 0 && (
        <ul className="space-y-2">
          {generatedDocs.map((d) => (
            <li key={d.id} className="flex items-center justify-between rounded-md border p-3 text-sm">
              <a
                href={`/api/documents/${d.id}/view`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 text-blue-600 hover:underline"
              >
                <FileText className="h-4 w-4" />
                {d.name}
              </a>
              <div className="flex items-center gap-2">
                {d.signatureStatus === "sent" ? (
                  <span className="text-green-700">Sent for signature</span>
                ) : d.signingMethod !== "NONE" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleSendForSignature(d.id)}
                    disabled={d.signatureStatus === "sending"}
                  >
                    <PenLine className="h-3 w-3 mr-1" />
                    Send for signature
                  </Button>
                ) : null}
                {d.signatureStatus === "error" && d.signatureError && (
                  <span className="text-red-700">{d.signatureError}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

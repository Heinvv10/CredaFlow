"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { EntityDocumentType } from "@prisma/client"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatDate } from "@/lib/utils"
import { ENTITY_DOCUMENT_LABELS } from "@/lib/asset-finance/labels"
import type { EntityDocumentView } from "@/lib/asset-finance/entity-documents"
import { DocumentUploadForm } from "./DocumentUploadForm"

/**
 * An entity's documents. `apiBase` is the documents collection URL (staff or
 * portal); opening a file goes through its access-logged GET. Verify and
 * delete are staff-only (`canManage`).
 */
export function DocumentsPanel({
  apiBase,
  documents,
  uploadTypes,
  canUpload,
  canManage,
}: {
  apiBase: string
  documents: EntityDocumentView[]
  uploadTypes: readonly EntityDocumentType[]
  canUpload: boolean
  canManage: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)

  async function act(doc: EntityDocumentView, action: "verify" | "delete") {
    if (action === "delete" && !window.confirm(`Delete ${doc.fileName}?`)) return
    setBusy(doc.id)
    try {
      const res = await fetch(
        action === "verify" ? `${apiBase}/${doc.id}/verify` : `${apiBase}/${doc.id}`,
        { method: action === "verify" ? "POST" : "DELETE" },
      )
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        toast.error(body.error ?? `Could not ${action} the document`)
        return
      }
      toast.success(action === "verify" ? "Document verified" : "Document deleted")
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <DataPanel
      title="Documents"
      description="Every time a file is opened, the access is logged."
      density="compact"
    >
      <div className="space-y-4">
        {canUpload && <DocumentUploadForm apiBase={apiBase} docTypes={uploadTypes} onUploaded={() => router.refresh()} />}
        {documents.length === 0 ? (
          <p className="text-sm text-[var(--cf-text-muted)]">No documents yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>File</TableHead>
                <TableHead>Uploaded</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{ENTITY_DOCUMENT_LABELS[d.docType]}</TableCell>
                  <TableCell className="max-w-[16rem] truncate text-xs">{d.fileName}</TableCell>
                  <TableCell className="text-xs">
                    {formatDate(d.createdAt)}
                    <span className="text-[var(--cf-text-muted)]"> · {d.uploadedByType === "client" ? "client" : "staff"}</span>
                  </TableCell>
                  <TableCell>
                    <StatusPill tone={d.verifiedAt ? "success" : "warning"}>{d.verifiedAt ? "Verified" : "Unverified"}</StatusPill>
                  </TableCell>
                  <TableCell className="space-x-1 whitespace-nowrap text-right">
                    <Button asChild size="sm" variant="ghost">
                      <a href={`${apiBase}/${d.id}`} target="_blank" rel="noopener noreferrer">View</a>
                    </Button>
                    <Button asChild size="sm" variant="ghost">
                      <a href={`${apiBase}/${d.id}?download=1`}>Download</a>
                    </Button>
                    {canManage && !d.verifiedAt && (
                      <Button size="sm" variant="outline" disabled={busy === d.id} onClick={() => act(d, "verify")}>
                        Verify
                      </Button>
                    )}
                    {canManage && (
                      <Button size="sm" variant="ghost" disabled={busy === d.id} onClick={() => act(d, "delete")}>
                        Delete
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </DataPanel>
  )
}

"use client"

import { useState } from "react"
import type { DocumentTemplateKind } from "@prisma/client"
import { toast } from "@/lib/toast"

export type TemplateRow = {
  id: string
  key: string
  name: string
  kind: DocumentTemplateKind
  isActive: boolean
  currentVersionIsActive: boolean
}

const KIND_BADGE: Record<DocumentTemplateKind, string> = {
  SYSTEM: "bg-blue-100 text-blue-800",
  CUSTOM: "bg-purple-100 text-purple-800",
}

function availabilityLabel(row: TemplateRow) {
  if (row.kind === "SYSTEM") return "Workflow managed"
  if (!row.isActive) return "Inactive"
  return row.currentVersionIsActive ? "Published" : "Not published"
}

export function DocumentTemplatesTable({ templates }: { templates: TemplateRow[] }) {
  const [rows, setRows] = useState(templates)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Task 8 (POST create + PATCH/DELETE) hasn't shipped yet — this call is a
  // forward reference to `app/api/documents/templates/[id]/route.ts` and will
  // 404 until that route lands.
  const handleDelete = async (row: TemplateRow) => {
    if (!confirm(`Delete template "${row.name}"? This cannot be undone.`)) return
    setDeletingId(row.id)
    const res = await fetch(`/api/documents/templates/${row.id}`, { method: "DELETE" })
    setDeletingId(null)
    if (res.ok) {
      toast.success("Template deleted")
      setRows((prev) => prev.filter((r) => r.id !== row.id))
    } else {
      const d = (await res.json().catch(() => ({}))) as { error?: string }
      toast.error(d.error ?? "Failed to delete template")
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            <th className="px-5 py-3 text-left">Name</th>
            <th className="px-5 py-3 text-left">Kind</th>
            <th className="px-5 py-3 text-left">Availability</th>
            <th className="px-5 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {rows.map((row) => (
            <tr key={row.id} className="hover:bg-gray-50">
              <td className="px-5 py-3 font-semibold text-[#1b1d24]">{row.name}</td>
              <td className="px-5 py-3">
                <span
                  className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${KIND_BADGE[row.kind]}`}
                >
                  {row.kind === "SYSTEM" ? "System" : "Custom"}
                </span>
              </td>
              <td className="px-5 py-3 text-xs text-gray-600">{availabilityLabel(row)}</td>
              <td className="px-5 py-3 text-right">
                <div className="flex items-center justify-end gap-3">
                  {row.kind === "SYSTEM" ? (
                    // SYSTEM templates render via NCA-specific pipelines (lib/pdf/*.ts),
                    // not the CUSTOM-only POST /api/documents/generate route (which 403s
                    // SYSTEM requests by design). No working UI path exists yet, so no
                    // generate links are rendered here.
                    <span className="text-xs text-gray-400">System document</span>
                  ) : (
                    <>
                      {/* Edit/Preview/Versions all resolve to the Task 10 editor page
                          (app/(dashboard)/settings/documents/[id]/edit) — Preview and
                          Publish happen inside that page, not on separate routes. */}
                      <a
                        href={`/settings/documents/${row.id}/edit`}
                        className="text-[#4F46E5] hover:underline text-xs font-medium"
                      >
                        Edit
                      </a>
                      <a
                        href={`/settings/documents/${row.id}/edit`}
                        className="text-[#4F46E5] hover:underline text-xs font-medium"
                      >
                        Preview
                      </a>
                      <button
                        onClick={() => handleDelete(row)}
                        disabled={deletingId === row.id}
                        className="text-red-500 hover:underline text-xs font-medium disabled:opacity-50"
                      >
                        {deletingId === row.id ? "Deleting…" : "Delete"}
                      </button>
                      <a
                        href={`/settings/documents/${row.id}/edit`}
                        className="text-[#4F46E5] hover:underline text-xs font-medium"
                      >
                        Versions
                      </a>
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="text-center py-12 text-gray-400">
                No document templates configured yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

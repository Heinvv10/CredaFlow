"use client"

import { useState } from "react"
import type { DocumentTemplateVersionStatus } from "@prisma/client"
import { EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/toast"
import { SAST_TIME_ZONE } from "@/lib/utils"

export type TemplateVersionRow = {
  id: string
  version: number
  status: DocumentTemplateVersionStatus
  createdAt: string
  notes: string | null
  createdById: string | null
  approvedById: string | null
  approvedAt: string | null
}

export type TokenOption = {
  token: string
  label: string
  group: string
}

const STATUS_BADGE: Record<DocumentTemplateVersionStatus, string> = {
  DRAFT: "bg-gray-100 text-gray-600",
  ACTIVE: "bg-green-100 text-green-700",
  ARCHIVED: "bg-gray-100 text-gray-400",
}

const editorWrapperCls =
  "w-full min-h-[380px] border border-gray-200 rounded-lg px-3 py-2 text-sm focus-within:outline-none focus-within:ring-2 focus-within:ring-amber-300"

const editorContentCls = "min-h-[356px] focus:outline-none"

const toolbarBtnCls = (active: boolean) =>
  `text-xs font-medium px-2.5 py-1.5 rounded-md border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
    active
      ? "bg-amber-100 text-amber-800 border-amber-200"
      : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
  }`

function ToolbarButton({
  onClick,
  active,
  disabled,
  label,
  children,
}: {
  onClick: () => void
  active?: boolean
  disabled?: boolean
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={!!active}
      className={toolbarBtnCls(!!active)}
    >
      {children}
    </button>
  )
}

export function DocumentTemplateEditor({
  templateId,
  initialBodyHtml,
  versions: initialVersions,
  tokens,
  currentUserId,
  requiresApproval,
}: {
  /** The signed-in admin: the author of a draft cannot approve it. */
  currentUserId: string
  /** The template's versions need approval by a second admin before they can be published. */
  requiresApproval: boolean
  templateId: string
  initialBodyHtml: string
  versions: TemplateVersionRow[]
  tokens: TokenOption[]
}) {
  const [bodyHtml, setBodyHtml] = useState(initialBodyHtml)
  const [versions, setVersions] = useState(initialVersions)
  const [preview, setPreview] = useState<{ html: string; missing: string[] } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [publishingId, setPublishingId] = useState<string | null>(null)
  const [approvingId, setApprovingId] = useState<string | null>(null)

  const editor = useEditor({
    extensions: [StarterKit],
    content: initialBodyHtml,
    immediatelyRender: false,
    onUpdate: ({ editor }) => setBodyHtml(editor.getHTML()),
    editorProps: {
      attributes: { class: editorContentCls },
    },
  })

  const groups: Record<string, TokenOption[]> = {}
  for (const t of tokens) {
    (groups[t.group] ??= []).push(t)
  }

  const insertToken = (token: string) => {
    const insertion = `{{${token}}}`
    if (!editor) {
      setBodyHtml((prev) => prev + insertion)
      return
    }
    editor.chain().focus().insertContent(insertion).run()
  }

  const handlePreview = async () => {
    setPreviewing(true)
    try {
      const res = await fetch(`/api/documents/templates/${templateId}/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bodyHtml }),
      })
      const data = (await res.json()) as { html?: string; missing?: string[]; error?: string }
      if (!res.ok) {
        toast.error(data.error ?? "Preview failed")
        return
      }
      setPreview({ html: data.html ?? "", missing: data.missing ?? [] })
      if (data.missing && data.missing.length > 0) {
        toast.warning(
          `${data.missing.length} token${data.missing.length === 1 ? "" : "s"} unresolved`,
          data.missing.join(", ")
        )
      } else {
        toast.success("Preview rendered")
      }
    } catch {
      toast.networkError()
    } finally {
      setPreviewing(false)
    }
  }

  const handleSaveDraft = async () => {
    setSaving(true)
    try {
      const res = await fetch(`/api/documents/templates/${templateId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bodyHtml }),
      })
      const data = (await res.json()) as TemplateVersionRow & { error?: string }
      if (!res.ok) {
        toast.error(data.error ?? "Failed to save draft")
        return
      }
      setVersions((prev) => [
        {
          id: data.id, version: data.version, status: data.status, createdAt: data.createdAt, notes: data.notes,
          createdById: data.createdById, approvedById: data.approvedById, approvedAt: data.approvedAt,
        },
        ...prev,
      ])
      toast.success("Draft saved", `Version ${data.version} created`)
    } catch {
      toast.networkError()
    } finally {
      setSaving(false)
    }
  }

  const handleApprove = async (versionId: string) => {
    setApprovingId(versionId)
    try {
      const res = await fetch(`/api/documents/templates/${templateId}/versions/${versionId}/approve`, { method: "POST" })
      const data = (await res.json()) as { error?: string; approvedById?: string; approvedAt?: string }
      if (!res.ok) {
        toast.error(data.error ?? "Failed to approve")
        return
      }
      setVersions((prev) => prev.map((v) => (v.id === versionId ? { ...v, approvedById: data.approvedById ?? currentUserId, approvedAt: data.approvedAt ?? new Date().toISOString() } : v)))
      toast.success("Version approved", "Anyone but you can now publish it")
    } catch {
      toast.networkError()
    } finally {
      setApprovingId(null)
    }
  }

  const handlePublish = async (versionId: string) => {
    setPublishingId(versionId)
    try {
      const res = await fetch(`/api/documents/templates/${templateId}/versions/${versionId}/publish`, {
        method: "POST",
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) {
        toast.error(data.error ?? "Failed to publish")
        return
      }
      setVersions((prev) =>
        prev.map((v) => {
          if (v.id === versionId) return { ...v, status: "ACTIVE" }
          if (v.status === "ACTIVE") return { ...v, status: "ARCHIVED" }
          return v
        })
      )
      toast.success("Template published")
    } catch {
      toast.networkError()
    } finally {
      setPublishingId(null)
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-6">
        <div className="bg-white rounded-2xl shadow-sm p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              Body HTML
            </h2>
          </div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            <ToolbarButton
              label="Bold"
              active={editor?.isActive("bold")}
              disabled={!editor}
              onClick={() => editor?.chain().focus().toggleBold().run()}
            >
              <span className="font-bold">B</span>
            </ToolbarButton>
            <ToolbarButton
              label="Italic"
              active={editor?.isActive("italic")}
              disabled={!editor}
              onClick={() => editor?.chain().focus().toggleItalic().run()}
            >
              <span className="italic">I</span>
            </ToolbarButton>
            <ToolbarButton
              label="Heading 2"
              active={editor?.isActive("heading", { level: 2 })}
              disabled={!editor}
              onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
            >
              H2
            </ToolbarButton>
            <ToolbarButton
              label="Heading 3"
              active={editor?.isActive("heading", { level: 3 })}
              disabled={!editor}
              onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
            >
              H3
            </ToolbarButton>
            <ToolbarButton
              label="Bullet list"
              active={editor?.isActive("bulletList")}
              disabled={!editor}
              onClick={() => editor?.chain().focus().toggleBulletList().run()}
            >
              • List
            </ToolbarButton>
            <ToolbarButton
              label="Numbered list"
              active={editor?.isActive("orderedList")}
              disabled={!editor}
              onClick={() => editor?.chain().focus().toggleOrderedList().run()}
            >
              1. List
            </ToolbarButton>
            <ToolbarButton
              label="Undo"
              disabled={!editor}
              onClick={() => editor?.chain().focus().undo().run()}
            >
              ↺
            </ToolbarButton>
            <ToolbarButton
              label="Redo"
              disabled={!editor}
              onClick={() => editor?.chain().focus().redo().run()}
            >
              ↻
            </ToolbarButton>
          </div>
          <div className={editorWrapperCls}>
            <EditorContent editor={editor} />
          </div>
          <style jsx global>{`
            .ProseMirror h2 {
              font-size: 1.15rem;
              font-weight: 600;
              margin: 0.75rem 0 0.4rem;
            }
            .ProseMirror h3 {
              font-size: 1rem;
              font-weight: 600;
              margin: 0.6rem 0 0.3rem;
            }
            .ProseMirror p {
              margin: 0.4rem 0;
            }
            .ProseMirror ul,
            .ProseMirror ol {
              padding-left: 1.25rem;
              margin: 0.4rem 0;
            }
            .ProseMirror ul {
              list-style: disc;
            }
            .ProseMirror ol {
              list-style: decimal;
            }
          `}</style>
          <div className="flex gap-2 mt-4">
            <Button variant="outline" onClick={handlePreview} disabled={previewing}>
              {previewing ? "Rendering…" : "Preview"}
            </Button>
            <Button
              onClick={handleSaveDraft}
              disabled={saving || !editor || editor.isEmpty}
              className="bg-[#4F46E5] hover:bg-[#4338CA]"
            >
              {saving ? "Saving…" : "Save draft"}
            </Button>
          </div>
        </div>

        {preview && (
          <div className="bg-white rounded-2xl shadow-sm p-5">
            <h2 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-3">
              Preview
            </h2>
            {preview.missing.length > 0 && (
              <div className="mb-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <p className="text-xs font-semibold text-amber-800 mb-1">
                  {preview.missing.length} unresolved token{preview.missing.length === 1 ? "" : "s"}
                </p>
                <div className="flex flex-wrap gap-1">
                  {preview.missing.map((token) => (
                    <span
                      key={token}
                      className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-amber-100 text-amber-800"
                    >
                      {`{{${token}}}`}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {/* Sandboxed with no `allow-scripts`/`allow-same-origin`: token
                values are resolved from DB records (e.g. client.fullName)
                and aren't HTML-escaped by renderTokens, so this preview can
                contain attacker-controlled markup from a client profile.
                An iframe with an empty sandbox renders the HTML visually
                without executing any script or sharing the admin's session. */}
            <iframe
              title="Template preview"
              srcDoc={preview.html}
              sandbox=""
              className="w-full min-h-[320px] border border-gray-200 rounded-lg bg-white"
            />
          </div>
        )}
      </div>

      <div className="space-y-6">
        <div className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-3">
            Insert token
          </h2>
          <div className="space-y-4 max-h-[380px] overflow-y-auto">
            {Object.entries(groups).map(([group, groupTokens]) => (
              <div key={group}>
                <p className="text-xs font-semibold text-gray-500 mb-1.5">{group}</p>
                <div className="flex flex-wrap gap-1.5">
                  {groupTokens.map((t) => (
                    <button
                      key={t.token}
                      type="button"
                      onClick={() => insertToken(t.token)}
                      disabled={!editor}
                      title={t.label}
                      className="text-[11px] font-mono px-2 py-1 rounded-full bg-gray-100 text-gray-700 hover:bg-amber-100 hover:text-amber-800 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {t.token}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 px-5 pt-5 pb-2">
            Versions
          </h2>
          <div className="divide-y divide-gray-50">
            {versions.map((v) => (
              <div key={v.id} className="px-5 py-3 flex items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-[#1b1d24]">v{v.version}</span>
                    <span
                      className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS_BADGE[v.status]}`}
                    >
                      {v.status}
                    </span>
                  </div>
                  <p className="text-[11px] text-gray-400 mt-0.5">
                    {new Date(v.createdAt).toLocaleString(undefined, { timeZone: SAST_TIME_ZONE })}
                  </p>
                </div>
                {v.status === "DRAFT" && requiresApproval && !v.approvedById && (
                  v.createdById === currentUserId ? (
                    <span className="text-[11px] text-gray-400" data-testid="awaiting-approval">Awaiting approval by a second admin</span>
                  ) : (
                    <button
                      onClick={() => handleApprove(v.id)}
                      disabled={approvingId === v.id}
                      className="text-[#4F46E5] hover:underline text-xs font-medium disabled:opacity-50"
                    >
                      {approvingId === v.id ? "Approving…" : "Approve"}
                    </button>
                  )
                )}
                {v.status === "DRAFT" && requiresApproval && v.approvedById && v.approvedById === currentUserId && (
                  <span className="text-[11px] text-gray-400">Approved by you; someone else publishes</span>
                )}
                {v.status === "DRAFT" && (!requiresApproval || (v.approvedById && v.approvedById !== currentUserId)) && (
                  <button
                    onClick={() => handlePublish(v.id)}
                    disabled={publishingId === v.id}
                    className="text-[#4F46E5] hover:underline text-xs font-medium disabled:opacity-50"
                  >
                    {publishingId === v.id ? "Publishing…" : "Publish"}
                  </button>
                )}
              </div>
            ))}
            {versions.length === 0 && (
              <p className="px-5 py-6 text-center text-sm text-gray-400">No versions yet.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

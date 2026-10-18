// Client calls of the asset-finance template editor: the shared template
// routes, with the server's refusal reasons passed through verbatim.
import type { AssetTemplateContent } from "./asset-template-types"

export interface ApiProblem {
  field: string
  message: string
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string; problems: ApiProblem[] }

async function call<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const data = (await res.json().catch(() => ({}))) as { error?: string; problems?: ApiProblem[] } & T
  return res.ok ? { ok: true, value: data } : { ok: false, error: data.error ?? `Request failed (${res.status})`, problems: data.problems ?? [] }
}

const base = (templateId: string) => `/api/documents/templates/${templateId}`

export const saveDraft = (templateId: string, content: AssetTemplateContent, notes: string) =>
  call<{ id: string; version: number }>(`${base(templateId)}/versions`, { content, notes })

export const approve = (templateId: string, versionId: string, body: { contentSha256: string; attestation: boolean; legalSignOffReference?: string }) =>
  call<{ approvalBasis: string }>(`${base(templateId)}/versions/${versionId}/approve`, body)

export const publish = (templateId: string, versionId: string) => call<{ archived: string[] }>(`${base(templateId)}/versions/${versionId}/publish`, {})

/** Open the preview PDF in a new tab; returns the previewed content hash (saved versions only). */
export async function openPreview(templateId: string, body: ({ versionId: string } | { content: AssetTemplateContent }) & { shape?: string }): Promise<ApiResult<{ sha: string | null }>> {
  const tab = window.open("", "_blank")
  const res = await fetch(`${base(templateId)}/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  if (!res.ok) {
    tab?.close()
    const data = (await res.json().catch(() => ({}))) as { error?: string; problems?: ApiProblem[] }
    return { ok: false, error: data.error ?? `Preview failed (${res.status})`, problems: data.problems ?? [] }
  }
  const url = URL.createObjectURL(await res.blob())
  if (tab) tab.location.href = url
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return { ok: true, value: { sha: res.headers.get("X-Template-Content-Sha256") } }
}

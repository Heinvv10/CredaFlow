"use client"

// Settings → Document templates: the asset-finance documents whose wording
// this lender owns. Adopting copies the starter wording into the lender's own
// draft (one template per variant); nothing is issued until a second admin
// approves a version and it is published.
import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/toast"

export interface AssetFamilyRow {
  family: string
  name: string
  variants: { key: string; label: string; templateId: string | null; published: number | null }[]
}

export function AssetTemplateFamilies({ families }: { families: AssetFamilyRow[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const adopt = async (family: string) => {
    setBusy(family)
    const res = await fetch("/api/documents/templates/asset-finance/adopt", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ family }),
    })
    setBusy(null)
    const data = (await res.json().catch(() => ({}))) as { error?: string; created?: string[] }
    if (!res.ok) return toast.error(data.error ?? "Could not adopt the starter wording")
    toast.success("Starter wording adopted", `${data.created?.length ?? 0} draft${data.created?.length === 1 ? "" : "s"} created for your review`)
    router.refresh()
  }
  return (
    <div className="bg-[var(--cf-bg-raised)] border border-[var(--cf-border-subtle)] rounded-2xl p-5 mb-6">
      <h2 className="text-sm font-semibold text-[var(--cf-text)]">Asset-finance legal templates</h2>
      <p className="text-xs text-[var(--cf-text-muted)] mt-1">
        Your own wording for asset-finance agreements, suretyships and resolutions. Documents are issued only from a version
        another admin has approved and published; figures, schedules and statutory content stay system-generated.
      </p>
      <ul className="mt-4 divide-y divide-[var(--cf-border-subtle)]">
        {families.map((f) => {
          const adopted = f.variants.every((v) => v.templateId)
          return (
            <li key={f.family} className="py-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between" data-testid={`family-${f.family}`}>
              <div>
                <p className="text-sm font-medium text-[var(--cf-text)]">{f.name}</p>
                <ul className="mt-1 space-y-0.5">
                  {f.variants.map((v) => (
                    <li key={v.key} className="text-xs text-[var(--cf-text-secondary)]">
                      {v.templateId ? <a className="text-[var(--cf-brand)] hover:underline" href={`/settings/documents/${v.templateId}/edit`}>{v.label}</a> : v.label}
                      {" — "}
                      {!v.templateId ? "not adopted" : v.published ? `version ${v.published} published` : "no published version (documents cannot be issued)"}
                    </li>
                  ))}
                </ul>
              </div>
              {!adopted && (
                <Button type="button" size="sm" variant="outline" disabled={busy === f.family} onClick={() => adopt(f.family)}>
                  {busy === f.family ? "Adopting…" : "Adopt starter wording"}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

"use client"

import { useState } from "react"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { ALT_MAX, COMMUNITY_BODY_MAX, COMMUNITY_HEADING_MAX, type CommunityImage, type ImageryImage, type ImagerySlot } from "@/lib/config/website-imagery-schema"

const API = "/api/settings/website-imagery"

type Message = { kind: "success" | "error"; text: string }

// Validation lives on the server (lib/config/website-imagery.ts): the file is
// checked by its content, so this only sends the bytes and text and shows the reason.
export function WebsiteImageSlot({ slot, title, hint, image, onChanged }: {
  slot: ImagerySlot
  title: string
  hint: string
  image: ImageryImage | CommunityImage | undefined
  onChanged: () => Promise<void>
}) {
  const community = slot === "community"
  const saved = image as Partial<CommunityImage> | undefined
  const [file, setFile] = useState<File | null>(null)
  const [alt, setAlt] = useState(saved?.alt ?? "")
  const [heading, setHeading] = useState(saved?.heading ?? "")
  const [body, setBody] = useState(saved?.body ?? "")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const id = `website-image-${slot}`

  async function send(method: "PUT" | "PATCH" | "DELETE") {
    setBusy(true)
    setMessage(null)
    try {
      const text = { alt, ...(community ? { heading, body } : {}) }
      let init: RequestInit = { method }
      if (method === "PUT") {
        const form = new FormData()
        form.set("file", file as File)
        for (const [name, value] of Object.entries(text)) form.set(name, value)
        init = { method, body: form }
      } else if (method === "PATCH") {
        init = { method, headers: { "content-type": "application/json" }, body: JSON.stringify(text) }
      }
      const res = await fetch(`${API}/${slot}`, init)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMessage({ kind: "error", text: data.error ?? "Failed to save." })
        return
      }
      setMessage({ kind: "success", text: method === "DELETE" ? "Removed." : data.changed ? "Saved." : "No change." })
      setFile(null)
      if (method === "DELETE") { setAlt(""); setHeading(""); setBody("") }
      await onChanged()
    } catch {
      setMessage({ kind: "error", text: "Failed to save." })
    } finally {
      setBusy(false)
    }
  }

  const canSave = !busy && alt.trim() !== "" && (file !== null || image !== undefined) && (!community || (heading.trim() !== "" && body.trim() !== ""))

  return (
    <div className="space-y-3 border-t pt-4 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- a per-tenant API response, not a static asset
        <img src={`/api/website/imagery/${slot}?v=${image.sha256.slice(0, 12)}`} alt={image.alt} className="h-24 w-auto max-w-xs rounded border border-input object-cover" />
      ) : (
        <p className="text-sm text-muted-foreground">No image set.</p>
      )}
      <div className="grid max-w-xl gap-3">
        <div className="space-y-1">
          <Label htmlFor={`${id}-file`}>{image ? "Replace the image" : "Upload an image"} (JPEG, PNG or WebP, at most 3 MB)</Label>
          <input id={`${id}-file`} type="file" accept="image/jpeg,image/png,image/webp" className="block w-full text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-alt`}>Alt text (describe the photo for screen readers)</Label>
          <input id={`${id}-alt`} value={alt} maxLength={ALT_MAX} onChange={(e) => setAlt(e.target.value)} className="block w-full rounded border border-input bg-background px-2 py-1 text-sm" />
        </div>
        {community && (
          <>
            <div className="space-y-1">
              <Label htmlFor={`${id}-heading`}>Heading</Label>
              <input id={`${id}-heading`} value={heading} maxLength={COMMUNITY_HEADING_MAX} onChange={(e) => setHeading(e.target.value)} className="block w-full rounded border border-input bg-background px-2 py-1 text-sm" />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-body`}>One sentence</Label>
              <textarea id={`${id}-body`} value={body} maxLength={COMMUNITY_BODY_MAX} rows={2} onChange={(e) => setBody(e.target.value)} className="block w-full rounded border border-input bg-background px-2 py-1 text-sm" />
            </div>
          </>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={() => send(file ? "PUT" : "PATCH")} disabled={!canSave}>{busy ? "Saving…" : file ? "Upload" : "Save text"}</Button>
        {image && <Button variant="outline" onClick={() => send("DELETE")} disabled={busy}>Remove</Button>}
        {message && <span className={`text-sm ${message.kind === "success" ? "text-green-600" : "text-red-600"}`}>{message.text}</span>}
      </div>
    </div>
  )
}

"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"

const LOGO_URL = "/api/settings/identity/logo"

async function fetchLogoState(): Promise<{ hasLogo: boolean; version: string }> {
  const res = await fetch(LOGO_URL, { method: "GET", cache: "no-store" })
  return { hasLogo: res.ok, version: String(Date.now()) }
}

// Validation lives on the server (lib/config/lender-logo.ts): the file is
// checked by its content, so this only sends the bytes and shows the reason.
export function LenderLogoUpload() {
  const [version, setVersion] = useState<string | null>(null)
  const [hasLogo, setHasLogo] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null)

  useEffect(() => {
    let ignore = false
    fetchLogoState()
      .then((state) => { if (!ignore) { setHasLogo(state.hasLogo); setVersion(state.version) } })
      .catch(() => { if (!ignore) setMessage({ kind: "error", text: "Failed to load the logo." }) })
    return () => { ignore = true }
  }, [])

  async function send(method: "POST" | "DELETE") {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch(LOGO_URL, method === "POST" ? { method, body: file } : { method })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setMessage({ kind: "success", text: method === "POST" ? (data.changed ? "Logo saved." : "That logo is already in use.") : "Logo removed." })
        setFile(null)
        const state = await fetchLogoState()
        setHasLogo(state.hasLogo)
        setVersion(state.version)
      } else {
        setMessage({ kind: "error", text: data.error ?? "Failed to save the logo." })
      }
    } catch {
      setMessage({ kind: "error", text: "Failed to save the logo." })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Letterhead logo</CardTitle>
        <CardDescription>
          Printed on NCA documents and shown in the staff workspace. PNG only, at most 512 KB and 2000×2000 pixels.
          Without a logo, documents print the legal name as a text letterhead.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasLogo && version ? (
          // eslint-disable-next-line @next/next/no-img-element -- an authenticated API response, not a static asset
          <img src={`${LOGO_URL}?v=${version}`} alt="Current letterhead logo" className="h-16 w-auto max-w-xs rounded border border-input bg-white object-contain p-2" />
        ) : (
          <p className="text-sm text-muted-foreground">No logo uploaded.</p>
        )}
        <div className="space-y-2 max-w-md">
          <Label htmlFor="lender-logo">Upload a new logo</Label>
          <input
            id="lender-logo"
            type="file"
            accept="image/png"
            className="block w-full text-sm"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={() => send("POST")} disabled={busy || !file}>
            {busy ? "Saving…" : "Upload logo"}
          </Button>
          {hasLogo && (
            <Button variant="outline" onClick={() => send("DELETE")} disabled={busy}>
              Remove logo
            </Button>
          )}
          {message && (
            <span className={`text-sm ${message.kind === "success" ? "text-green-600" : "text-red-600"}`}>{message.text}</span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

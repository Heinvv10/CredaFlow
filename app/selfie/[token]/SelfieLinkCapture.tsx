"use client"

import { useState } from "react"
import { SelfieCapture } from "@/components/documents/SelfieCapture"

export type UploadOutcome = { ok: true } | { ok: false; error: string }

/**
 * Posts the captured frame to the token's capture endpoint.
 *
 * Split out of the component because the test harness runs in node with no DOM,
 * so this is the only way the URL construction and the error handling get real
 * coverage rather than being asserted by eye.
 *
 * The token travels in the path and never in the body — it is the credential,
 * and a body copy would show up in logs and proxies that do not log paths.
 */
export async function uploadSelfieCapture(token: string, file: File): Promise<UploadOutcome> {
  const fd = new FormData()
  fd.append("image", file)
  try {
    const res = await fetch(`/api/selfie-link/${token}/capture`, { method: "POST", body: fd })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      // Prefer the server's own wording: it distinguishes expired from used
      // from superseded, which is exactly what tells the consumer whether to
      // ask for a new link or look further up the chat thread.
      return { ok: false, error: data.error ?? "That photo could not be accepted. Please try again." }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: "Network error — please try again." }
  }
}

export function SelfieLinkCapture({ token, firstName }: { token: string; firstName: string }) {
  const [status, setStatus] = useState<"idle" | "sending" | "done">("idle")
  const [error, setError] = useState<string | null>(null)

  const upload = async (file: File) => {
    setStatus("sending")
    setError(null)
    const result = await uploadSelfieCapture(token, file)
    if (result.ok) {
      setStatus("done")
      return
    }
    setError(result.error)
    setStatus("idle")
  }

  if (status === "done") {
    return (
      <div className="mx-auto max-w-md p-6 text-center">
        <h1 className="text-lg font-semibold">Thank you, {firstName}</h1>
        <p className="mt-2 text-sm">
          We have received your photo. Your consultant will continue from here.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md p-6">
      <h1 className="text-lg font-semibold">Hello {firstName}</h1>
      <p className="mt-2 text-sm">
        Please take a photo of your face so we can check it against the photo on your
        ID document. Look straight at the camera in good light.
      </p>
      {error && (
        <p
          role="alert"
          className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {error}
        </p>
      )}
      <div className="mt-4">
        <SelfieCapture onCapture={upload} disabled={status === "sending"} />
      </div>
    </div>
  )
}

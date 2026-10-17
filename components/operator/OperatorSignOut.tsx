"use client"

import { useRef, useState } from "react"
import { signOut } from "next-auth/react"
import { Button } from "@/components/ui/button"

export function OperatorSignOut({ label = "Sign out", variant = "outline" }: {
  label?: string
  variant?: "default" | "outline"
}) {
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function leave() {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError(null)
    try {
      // Auth.js canonicalises relative callback URLs to the lender origin.
      // End this host's session first, then keep navigation on the console.
      await signOut({ redirect: false })
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Fully reload the same-host login after ending the held/enrolled session view.
      window.location.assign("/operator/login")
    } catch {
      inFlight.current = false
      setPending(false)
      setError("Could not sign out. Try again.")
    }
  }

  return (
    <div className="space-y-2">
      <Button size="sm" variant={variant} disabled={pending} onClick={leave}>
        {pending ? "Signing out…" : label}
      </Button>
      {error ? <p role="alert" className="max-w-xs text-xs text-[var(--cf-danger)]">{error}</p> : null}
    </div>
  )
}

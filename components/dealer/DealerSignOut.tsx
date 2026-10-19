"use client"

import { useRef, useState } from "react"
import { signOut } from "next-auth/react"
import { Button } from "@/components/ui/button"

/** Ends this host's session, then reloads the dealer sign-in on the same host. */
export function DealerSignOut() {
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function leave() {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError(null)
    try {
      await signOut({ redirect: false })
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Fully reload the same-host login after ending the session.
      window.location.assign("/dealer/login")
    } catch {
      inFlight.current = false
      setPending(false)
      setError("Could not sign out. Try again.")
    }
  }

  return (
    <div className="space-y-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={leave}>
        {pending ? "Signing out…" : "Sign out"}
      </Button>
      {error ? <p role="alert" className="max-w-xs text-xs text-[var(--cf-danger)]">{error}</p> : null}
    </div>
  )
}

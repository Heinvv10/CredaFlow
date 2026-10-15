"use client"

import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError } from "@/components/asset-finance/register-form-controls"
import { useLegalAction, type LegalCall } from "./legal-matter-client"

/** One status-driven step: its POST(s) run in order, the page refreshes, a refusal shows under the button verbatim. */
export function StepButton({ calls, label, busyLabel, variant }: {
  calls: LegalCall[]
  label: string
  busyLabel: string
  variant?: "default" | "outline" | "destructive"
}) {
  const { busy, error, runAll } = useLegalAction()
  return (
    <div className="space-y-2">
      <Button size="sm" variant={variant ?? "default"} disabled={busy} onClick={() => runAll(calls)}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {busy ? busyLabel : label}
      </Button>
      <FormError message={error} />
    </div>
  )
}

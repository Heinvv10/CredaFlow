"use client"

import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError } from "@/components/asset-finance/register-form-controls"
import { useLeaseAction } from "./lease-action"

/** One status-driven step with a fixed body (approve, invoice, request a quote, …); a refusal shows under the button. */
export function LeaseActionButton(props: {
  url: string
  label: string
  busyLabel: string
  body?: Record<string, unknown>
  variant?: "default" | "outline" | "destructive"
}) {
  const { busy, error, run } = useLeaseAction()
  return (
    <div className="space-y-2">
      <Button size="sm" variant={props.variant ?? "default"} disabled={busy} onClick={() => run(props.url, props.body ?? {})}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {busy ? props.busyLabel : props.label}
      </Button>
      <FormError message={error} />
    </div>
  )
}

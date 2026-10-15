"use client"

import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError } from "@/components/asset-finance/register-form-controls"
import { useLegalAction } from "./legal-matter-client"

/** Opens the loan's legal matter (POST .../loans/[loanId]/legal-matter); a refusal shows under the button. */
export function OpenLegalMatterButton({ loanId }: { loanId: string }) {
  const { busy, error, run } = useLegalAction()
  return (
    <div className="space-y-2">
      <Button size="sm" disabled={busy} onClick={() => run(`/api/asset-finance/loans/${loanId}/legal-matter`, {})}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {busy ? "Opening…" : "Open legal matter"}
      </Button>
      <FormError message={error} />
    </div>
  )
}

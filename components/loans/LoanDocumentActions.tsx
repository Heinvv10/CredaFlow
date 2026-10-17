import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * The NCA document set a staff member can pull for a loan.
 *
 * `showSection129` is gated on a RETRIEVABLE issued artifact, not on the loan's
 * collections stage: the notice is a real legal letter, and offering a download
 * for one that was never issued would imply it went out.
 */
export function LoanDocumentActions({
  loanId,
  showSection129,
  section129Simulated = false,
}: {
  loanId: string
  showSection129: boolean
  /** The notice on file was simulated on a demo stack and never sent. */
  section129Simulated?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <a href={`/api/loans/${loanId}/statement`} target="_blank" rel="noopener noreferrer">
        <Button variant="outline" size="sm"><Download className="mr-1 h-4 w-4" />Statement</Button>
      </a>
      <a href={`/api/loans/${loanId}/certificate-of-balance`} target="_blank" rel="noopener noreferrer">
        <Button variant="outline" size="sm"><Download className="mr-1 h-4 w-4" />COB</Button>
      </a>
      <a href={`/api/loans/${loanId}/debit-mandate`} target="_blank" rel="noopener noreferrer">
        <Button variant="outline" size="sm"><Download className="mr-1 h-4 w-4" />Debit Mandate Draft</Button>
      </a>
      {showSection129 && (
        <a href={`/api/loans/${loanId}/section129-pdf`} target="_blank" rel="noopener noreferrer">
          <Button variant="outline" size="sm" className="border-[rgba(208,92,75,0.45)] text-[var(--cf-danger)] hover:bg-[rgba(208,92,75,0.08)]">
            <Download className="mr-1 h-4 w-4" />{section129Simulated ? "S129 Notice (simulated, not sent)" : "S129 Notice"}
          </Button>
        </a>
      )}
    </div>
  )
}

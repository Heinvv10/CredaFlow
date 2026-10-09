export type LoanNote = {
  id: string
  type: string
  note: string
  documentId: string | null
  createdBy: string
  createdAt: string
}

/**
 * Fetches GET /api/loans/:id/notes and validates the response before
 * parsing. Throws on a non-OK response instead of silently rendering an
 * empty notes list when the request was actually rejected.
 */
export async function loadLoanNotes(loanId: string): Promise<LoanNote[]> {
  const res = await fetch(`/api/loans/${loanId}/notes`)
  if (!res.ok) throw new Error("Failed to load notes")
  return res.json() as Promise<LoanNote[]>
}

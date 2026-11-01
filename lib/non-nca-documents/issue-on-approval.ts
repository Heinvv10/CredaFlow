import { issueLoanDocuments } from "./issue"

/**
 * An approved key-facts application gets its offer letter, key facts statement and loan agreement at once
 * (tender 2.4.3). The approval stands whatever happens here: a template the lender has not published leaves
 * the documents to the staff panel's Issue button, which says why.
 */
export async function issueOnApproval(args: { tenantId: string; applicationId: string; staff: { id: string; email: string } }): Promise<void> {
  try {
    const result = await issueLoanDocuments(args)
    if (!result.ok) console.error(`[non-nca-documents] documents not issued on approval of ${args.applicationId}: ${result.error}`)
  } catch (error) {
    console.error(`[non-nca-documents] documents not issued on approval of ${args.applicationId}:`, error instanceof Error ? error.message : "unknown error")
  }
}

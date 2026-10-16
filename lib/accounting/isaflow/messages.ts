/**
 * Push messages the staff screen recognises (components/accounting/IsaFlowPushControl.tsx).
 * No server imports here: the client bundle reads this file.
 */
export const DELETED_DRAFT_REPLAYED = "draft deleted in IsaFlow; key replays the old id"

export function deletedDraftError(journalId: string): string {
  return `${DELETED_DRAFT_REPLAYED} (${journalId}). IsaFlow will not create this month again under its key: post it in IsaFlow from the CSV download (or have IsaFlow re-key it), then resolve`
}

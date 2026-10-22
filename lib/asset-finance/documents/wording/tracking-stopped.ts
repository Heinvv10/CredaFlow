// The "tracking stopped" notice (docs/asset-finance/SLICE5-FOLLOWUPS.md part T):
// told to the borrower when an agreement with a tracker on its asset ends, in
// the portal, by email and in a stored letter. The same words in all three.
// UNTESTED: legal — merged on a blind SA-legal reviewer's SHIP (goal §2a 7);
// each lender's legal team approves it before go-live.

export interface TrackingStoppedFacts {
  lenderName: string
  loanReference: string
  assetDescription: string
  /** The SAST calendar date the agreement ended (yyyy-mm-dd), already formatted for the reader. */
  endedOn: string
  /** The business that was the borrower, when it was one: its people get the notice, and are not parties to it. */
  entityName: string | null
  /** The lender's position retention (TenantConfig.telematicsPositionRetentionDays). */
  retentionDays: number
}

export const TRACKING_STOPPED_TITLE = "Tracking has stopped"

/** The notice's paragraphs, in order (words revised on the SA-legal review of PR #238). */
export function trackingStoppedParagraphs(f: TrackingStoppedFacts): string[] {
  const ended = f.entityName
    ? `The agreement ${f.loanReference} between ${f.entityName} and ${f.lenderName} ended on ${f.endedOn}.`
    : `Your agreement ${f.loanReference} with ${f.lenderName} ended on ${f.endedOn}.`
  return [
    `${ended} From that date we no longer keep the location, meter readings or any other information that the tracking device fitted to the ${f.assetDescription} sends us.`,
    "The device may keep sending signals to the tracking company until it is removed or switched off. We will contact you to arrange this. Until then we keep only a record of when the device was last switched on, never where it was or its readings.",
    `We delete the location records collected while the agreement ran ${f.retentionDays} days after each record is made. You may ask us for a copy of the information we hold about you, or ask us to correct or delete it. You may also complain to the Information Regulator.`,
  ]
}

export function trackingStoppedEmail(f: TrackingStoppedFacts): { subject: string; text: string; html: string } {
  const paragraphs = trackingStoppedParagraphs(f)
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return {
    subject: `${TRACKING_STOPPED_TITLE}: ${f.loanReference}`,
    text: paragraphs.join("\n\n"),
    html: paragraphs.map((p) => `<p>${escape(p)}</p>`).join("\n"),
  }
}

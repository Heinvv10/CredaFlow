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
}

export const TRACKING_STOPPED_TITLE = "Tracking has stopped"

/** The notice's paragraphs, in order. */
export function trackingStoppedParagraphs(f: TrackingStoppedFacts): string[] {
  return [
    `Your agreement ${f.loanReference} with ${f.lenderName} ended on ${f.endedOn}. From that date we stopped collecting the location and any other information from the tracking device fitted to the ${f.assetDescription}.`,
    "We will contact you to arrange for the device to be removed or switched off. Until then it sends us nothing that we keep.",
    `Location records collected while the agreement ran are deleted at the end of the retention period set out in ${f.lenderName}'s privacy notice. You may ask us for a copy of the information we hold about you, or ask us to correct it.`,
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

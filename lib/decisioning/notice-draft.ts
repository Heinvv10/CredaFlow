/**
 * A starting point shown in Settings for the lender's legal team to rewrite. It is
 * NOT wording anyone approved and is never sent: the engine-settings payload
 * refuses any notice containing "draft", "TODO" or "TBC", so this text cannot be
 * saved as it stands.
 *
 * TODO(lender legal team): supply the wording for an automated credit decision
 * (POPIA s71: that a decision was made by automated means, the right to make
 * representations and to ask for a person to review it, and how). CredaFlow ships
 * none; the lender's counsel signs it off with the s71 sign-off.
 */
export const DRAFT_AUTOMATED_DECLINE_NOTICE =
  "DRAFT, NOT APPROVED WORDING. TODO(legal team): say that this decision was made by automated means, that the client may make representations, and how to ask for a person to review it."

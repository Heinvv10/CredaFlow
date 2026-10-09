export const COLLECTIONS_STAGE_ORDER = {
  NONE: 0,
  SOFT_REMINDER: 1,
  FORMAL_REMINDER: 2,
  SECTION_129_SENT: 3,
  PAYMENT_ARRANGEMENT: 4,
  ATTORNEY_REFERRED: 5,
  WRITTEN_OFF: 6,
} as const

export type CollectionsStageName = keyof typeof COLLECTIONS_STAGE_ORDER

/** Unknown persisted values fail closed as later than every supported stage. */
export function collectionsStageRank(stage: string | null | undefined): number {
  if (!stage || !Object.prototype.hasOwnProperty.call(COLLECTIONS_STAGE_ORDER, stage)) {
    return Number.POSITIVE_INFINITY
  }
  return COLLECTIONS_STAGE_ORDER[stage as CollectionsStageName]
}

export function isCollectionsStageAtOrAfter(
  current: string | null | undefined,
  required: CollectionsStageName,
): boolean {
  return collectionsStageRank(current) >= COLLECTIONS_STAGE_ORDER[required]
}

export function wouldRegressCollectionsStage(
  current: string | null | undefined,
  requested: CollectionsStageName,
): boolean {
  return collectionsStageRank(current) > COLLECTIONS_STAGE_ORDER[requested]
}

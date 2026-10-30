/**
 * One person, one seat. An application has a small number of seats: the people who made it, one per approved level, and whoever
 * recorded the credit committee's decision. A person fills one seat, and so does the person whose authority they acted on. So the
 * *principals* of an act are the person who did it and, when they acted on a delegation, the delegator; across all the acts on a
 * case no principal appears twice. The database enforces the same rule (`approvalSeatTaken`, migration 20261030100000).
 */

export type SeatReason =
  /** Captured the application or changed its inputs. */
  | "MAKER"
  /** Approved a level themselves. */
  | "APPROVED"
  /** Their authority was used by a delegate (to approve a level or to record the committee's decision). */
  | "DELEGATOR_ACTED"
  /** Recorded the committee's decision. */
  | "RECORDED"

/** One act on a case: who did it, and whose authority they used (the delegator) when it was a delegation. */
export interface SeatedAct {
  actorId: string
  authorityHolderId: string | null
}

/** Who has acted for an act: the person, and the delegator behind them. */
export const principalsOf = (act: SeatedAct): string[] => (act.authorityHolderId === null ? [act.actorId] : [act.actorId, act.authorityHolderId])

/**
 * Every principal already seated on a case, with why. A maker keeps that reason over any other. Pass `recorders` without the candidate's own
 * earlier decisions when the candidate is a committee recorder (one member may record several decisions).
 */
export function seatMap(input: { makerIds: readonly string[]; steps: readonly SeatedAct[]; recorders: readonly SeatedAct[] }): Map<string, SeatReason> {
  const seats = new Map<string, SeatReason>()
  const seat = (id: string, reason: SeatReason) => { if (!seats.has(id)) seats.set(id, reason) }
  for (const id of input.makerIds) seat(id, "MAKER")
  for (const act of input.steps) {
    seat(act.actorId, "APPROVED")
    if (act.authorityHolderId !== null) seat(act.authorityHolderId, "DELEGATOR_ACTED")
  }
  for (const act of input.recorders) for (const id of principalsOf(act)) seat(id, "RECORDED")
  return seats
}

/** The reason a candidate cannot take a seat (the first of their principals already seated), or null. */
export function seatConflict(seats: ReadonlyMap<string, SeatReason>, candidate: SeatedAct): SeatReason | null {
  for (const id of principalsOf(candidate)) {
    const reason = seats.get(id)
    if (reason !== undefined) return reason
  }
  return null
}

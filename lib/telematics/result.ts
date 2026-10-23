/** Who acts on telematics in the staff app, and what a staff action answers (a route maps `status` as is). */
export interface TelematicsActor {
  tenantId: string
  userId: string
  userEmail: string
}

export interface TelematicsRefusal {
  kind: "refused"
  status: 400 | 403 | 404 | 409 | 422
  error: string
  fields?: Record<string, string>
}

export type TelematicsResult<T extends object = object> = ({ kind: "ok" } & T) | TelematicsRefusal

export function refused(status: TelematicsRefusal["status"], error: string, fields?: Record<string, string>): TelematicsRefusal {
  return fields ? { kind: "refused", status, error, fields } : { kind: "refused", status, error }
}

/** A JSON object body, or null. */
export function objectBody(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null
}

/** A staff note of 3 to 500 characters (the database's bound), trimmed, or null. */
export function noteOf(value: unknown): string | null {
  if (typeof value !== "string") return null
  const note = value.trim()
  return note.length >= 3 && note.length <= 500 ? note : null
}

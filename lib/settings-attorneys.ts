export type AttorneyFirm = {
  id: string
  name: string
  contactPerson: string | null
  phone: string | null
  email: string | null
  address: string | null
  specialisation: string | null
  active: boolean
  createdAt: string
}

/**
 * Fetches GET /api/settings/attorneys and validates the response before
 * parsing. Throws on a non-OK response instead of letting callers treat an
 * error body as a firm list.
 */
export async function loadAttorneyFirms(includeInactive: boolean): Promise<AttorneyFirm[]> {
  const res = await fetch(`/api/settings/attorneys?includeInactive=${includeInactive}`, { credentials: "include" })
  if (!res.ok) throw new Error("Failed to load attorney firms")
  return res.json() as Promise<AttorneyFirm[]>
}

export type Insurer = {
  id: string
  name: string
  fspNumber: string | null
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  apiEndpoint: string | null
  active: boolean
  createdAt: string
}

/**
 * Fetches GET /api/insurers and validates the response before parsing.
 * Throws on a non-OK response instead of letting callers treat an error
 * body as an insurer list.
 */
export async function loadInsurers(): Promise<Insurer[]> {
  const res = await fetch("/api/insurers")
  if (!res.ok) throw new Error("Failed to load insurers")
  return res.json() as Promise<Insurer[]>
}

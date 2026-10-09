export type Branch = { id: string; name: string }

export type SettingsUser = {
  id: string
  name: string | null
  email: string
  role: string
  active: boolean
  phone?: string | null
  lastLoginAt?: string | null
  branchId?: string | null
  branch?: { id: string; name: string } | null
  createdAt: string
  _count?: { approvedLoans: number; assignedLoans: number; auditLogs: number }
}

export type SettingsUsersResponse = { users: SettingsUser[]; branches: Branch[] }

/**
 * Fetches GET /api/settings/users and validates the response before parsing.
 * Throws on a non-OK response (e.g. the BRANCH_MANAGER guard rejecting a
 * lower role) instead of letting callers destructure an error body as data.
 */
export async function loadUsers(): Promise<SettingsUsersResponse> {
  const res = await fetch("/api/settings/users")
  if (!res.ok) throw new Error("Failed to load users")
  return res.json() as Promise<SettingsUsersResponse>
}

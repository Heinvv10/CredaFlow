// Pure: no imports that reach @/lib/auth (NextAuth), so the anonymous website-chat
// routes can use it. lib/inbox/authz.ts re-exports it for the session guards.
import { hasMinRole, type UserRole } from "@/lib/permissions"

// The one definition of "has inbox access": staff (READONLY+) AND (flagged OR admin).
// CLIENT and any unknown role never pass.
export function isCommsAgentAllowed(role: string, isCommsAgent: boolean): boolean {
  const r = role as UserRole // hasMinRole denies anything not in its hierarchy
  if (!hasMinRole(r, "READONLY")) return false // excludes CLIENT + unknown roles
  return isCommsAgent || hasMinRole(r, "ADMIN")
}

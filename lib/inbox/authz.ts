import { redirect } from "next/navigation"
import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import type { StaffUser } from "@/lib/auth-guards"
import { redirectStaleSession } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { isCommsAgentAllowed } from "./comms-agent"

// The predicate lives in ./comms-agent (pure, no NextAuth); re-exported for existing imports.
export { isCommsAgentAllowed }

export type CommsAgentGuard =
  | { user: StaffUser; error?: never }
  | { user?: never; error: NextResponse }

// API guard. Fresh isCommsAgent lookup — never from the JWT (admin toggles
// must apply without re-login; avoids the stale-JWT redirect-loop class).
export async function requireCommsAgent(): Promise<CommsAgentGuard> {
  const session = await auth()
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  }
  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { isCommsAgent: true },
  })
  if (!isCommsAgentAllowed(session.user.role, dbUser?.isCommsAgent ?? false)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  }
  return { user: session.user as StaffUser }
}

// Page guard. Redirects instead of returning JSON.
export async function requireCommsAgentPage(): Promise<StaffUser> {
  const session = await auth()
  if (!session?.user) redirectStaleSession()
  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { isCommsAgent: true },
  })
  if (!isCommsAgentAllowed(session.user.role, dbUser?.isCommsAgent ?? false)) redirect("/")
  return session.user as StaffUser
}

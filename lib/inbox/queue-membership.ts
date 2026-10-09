import type { InboxQueue } from "./conversations"

// Whether a conversation belongs to `queue`, given only its status/assignee
// (no DB round trip). Mirrors queueWhere's Prisma filter in conversations.ts
// branch-for-branch — keep them in sync when either changes; matchesQueue is
// exhaustively tested in conversations.test.ts as the drift guard.
//
// Deliberately its own file with zero server-only imports (no `lib/prisma`):
// InboxClient.tsx (a client component) needs this at runtime to decide
// whether a status/assignee change moved a pinned conversation out of its
// queue, and conversations.ts imports `@/lib/prisma` at module scope — a
// runtime import of matchesQueue from there would pull Prisma into the
// client bundle. conversations.ts re-exports this for server-side callers.
export function matchesQueue(
  queue: InboxQueue,
  cv: { status: string; assigneeId: string | null },
  agentUserId: string,
): boolean {
  if (queue === "closed") return cv.status === "CLOSED"
  if (cv.status === "CLOSED") return false
  if (queue === "unassigned") return cv.assigneeId === null
  if (queue === "mine") return cv.assigneeId === agentUserId
  return true // "all"
}

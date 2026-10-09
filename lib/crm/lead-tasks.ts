// Shape + validation rules for a staff-created lead task.
//
// Prisma-free by construction: the Tasks panel is a client component and
// imports the labels and predicates below, while POST /api/agent-tasks imports
// the validator and the reminder cron imports the status lists. A client
// component that reaches a prisma-importing module bundles server code for the
// browser and only `npm run build` catches it — hence the same pure/impure
// split as lib/crm/lead-assignment.ts (pure) vs lib/crm/staff.ts (queries).

/** AgentTask.priority is a free string in the schema; these are the values the
 *  automation engine already writes (lib/automation/built-in-rules.ts). */
export const TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

/** AgentTask.status is likewise a free string. This is the one list — PATCH
 *  /api/agent-tasks/[id] imports it rather than repeating a literal, so a
 *  status accepted by one write path cannot be rejected by the other. */
export const TASK_STATUSES = ["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** Statuses that still want doing — what the panel lists and the cron reminds on. */
export const OPEN_TASK_STATUSES = ["PENDING", "IN_PROGRESS"] as const

/** Staff-created tasks get this `type`; the automation engine writes its own
 *  (e.g. "REVIEW_STALE_LEAD"), so the origin of a row stays legible. */
export const MANUAL_TASK_TYPE = "MANUAL"

/** `AgentTask.entityType` for a lead. The (entityType, entityId) pair is
 *  polymorphic and has no FK, so the literal is shared rather than retyped:
 *  the create route, the panel query and the reminder cron must all agree or a
 *  task is written under one spelling and read under another. */
export const LEAD_ENTITY_TYPE = "Lead"

export const MAX_TASK_TITLE = 120
export const MAX_TASK_DESCRIPTION = 2000

export function isTaskPriority(v: unknown): v is TaskPriority {
  return typeof v === "string" && (TASK_PRIORITIES as readonly string[]).includes(v)
}

export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && (TASK_STATUSES as readonly string[]).includes(v)
}

export type NewLeadTask = {
  title: string
  description: string | null
  priority: TaskPriority
  dueAt: Date | null
  assigneeId: string | null
}

export type ValidationResult =
  | { ok: true; value: NewLeadTask }
  | { ok: false; error: string }

/**
 * Validate a staff-submitted task payload.
 *
 * Fails closed on every field: `AgentTask.title` has no DB length limit and
 * `priority`/`status` are free strings, so without this an API caller could
 * store a 1MB title or a priority of "🔥" that no UI branch handles. The title
 * also ends up in a WhatsApp/email reminder body (lib/notifications/
 * task-reminder.ts), which is why it is capped here rather than only in the
 * form.
 */
export function validateNewLeadTask(raw: {
  title?: unknown
  description?: unknown
  priority?: unknown
  dueAt?: unknown
  assigneeId?: unknown
}): ValidationResult {
  if (typeof raw.title !== "string") return { ok: false, error: "Title is required" }
  const title = raw.title.trim()
  if (!title) return { ok: false, error: "Title is required" }
  if (title.length > MAX_TASK_TITLE) {
    return { ok: false, error: `Title must be ${MAX_TASK_TITLE} characters or fewer` }
  }

  let description: string | null = null
  if (raw.description !== undefined && raw.description !== null && raw.description !== "") {
    if (typeof raw.description !== "string") return { ok: false, error: "Invalid description" }
    const trimmed = raw.description.trim()
    if (trimmed.length > MAX_TASK_DESCRIPTION) {
      return { ok: false, error: `Description must be ${MAX_TASK_DESCRIPTION} characters or fewer` }
    }
    description = trimmed || null
  }

  let priority: TaskPriority = "MEDIUM"
  if (raw.priority !== undefined && raw.priority !== null && raw.priority !== "") {
    if (!isTaskPriority(raw.priority)) return { ok: false, error: "Invalid priority" }
    priority = raw.priority
  }

  let dueAt: Date | null = null
  if (raw.dueAt !== undefined && raw.dueAt !== null && raw.dueAt !== "") {
    if (typeof raw.dueAt !== "string") return { ok: false, error: "Invalid due date" }
    const parsed = new Date(raw.dueAt)
    // `new Date("banana")` is an Invalid Date object, not a throw — it would
    // reach Prisma and fail there as an opaque 500 instead of a 400.
    if (Number.isNaN(parsed.getTime())) return { ok: false, error: "Invalid due date" }
    dueAt = parsed
  }

  let assigneeId: string | null = null
  if (raw.assigneeId !== undefined && raw.assigneeId !== null && raw.assigneeId !== "") {
    if (typeof raw.assigneeId !== "string") return { ok: false, error: "Invalid assignee" }
    assigneeId = raw.assigneeId
  }

  return { ok: true, value: { title, description, priority, dueAt, assigneeId } }
}

/** A task is overdue once its due time has passed and it is still open. */
export function isTaskOverdue(
  task: { status: string; dueAt: Date | string | null },
  now: number = Date.now()
): boolean {
  if (!task.dueAt) return false
  if (!(OPEN_TASK_STATUSES as readonly string[]).includes(task.status)) return false
  return new Date(task.dueAt).getTime() <= now
}

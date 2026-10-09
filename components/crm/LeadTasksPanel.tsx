"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Square, Clock, AlertTriangle, Loader2 } from "lucide-react"
import {
  TASK_PRIORITIES,
  isTaskOverdue,
  MAX_TASK_TITLE,
  type TaskPriority,
} from "@/lib/crm/lead-tasks"
import { type AssignableStaff } from "@/lib/crm/lead-assignment"
import { formatDateTime } from "@/lib/utils"

// Imports only prisma-free modules (lib/crm/lead-tasks, lib/crm/lead-assignment,
// lib/utils). Reaching lib/crm/staff.ts or lib/notifications/bell.ts from here
// would bundle prisma for the browser, and only `npm run build` catches that.

export type LeadTask = {
  id: string
  title: string
  description: string | null
  priority: string
  status: string
  dueAt: string | null
  assignee: { id: string; name: string | null; email: string } | null
}

const PRIORITY_STYLE: Record<string, { bg: string; text: string }> = {
  LOW: { bg: "#F3F4F6", text: "#4B5563" },
  MEDIUM: { bg: "#DBEAFE", text: "#1E40AF" },
  HIGH: { bg: "#FEF3C7", text: "#92400E" },
  URGENT: { bg: "#FEE2E2", text: "#991B1B" },
}

export function LeadTasksPanel({
  leadId,
  tasks,
  staff,
  canCreate,
  canManage,
  currentUserId,
  onChanged,
}: {
  leadId: string
  tasks: LeadTask[]
  staff: AssignableStaff[]
  /** Mirrors the CREDIT_OFFICER gate on POST /api/agent-tasks. The API
   *  re-checks it — this only decides whether to render the controls. */
  canCreate: boolean
  /** Mirrors PATCH's `canManage`: may act on ANY task, not just your own. A
   *  separate prop from canCreate on purpose — they mirror DIFFERENT gates and
   *  only coincide today. Reusing canCreate here would mean that raising the
   *  POST bar silently strips the Complete button from people the API would
   *  still accept it from. */
  canManage: boolean
  /** Whose session this is. Completing is decided per-row: the assignment is
   *  the authorisation, so your own task is always closeable by you even if
   *  you could not have created it. PATCH re-checks. */
  currentUserId: string
  /** Called after a successful create/complete, in ADDITION to router.refresh().
   *  The full page relies on router.refresh() (it server-renders the list); the
   *  slide-over passes this to re-fetch its own bundle, whose state a router
   *  refresh does not touch. Optional so the page keeps its existing behaviour. */
  onChanged?: () => void
}) {
  const router = useRouter()
  const [showForm, setShowForm] = useState(false)
  const [title, setTitle] = useState("")
  const [priority, setPriority] = useState<TaskPriority>("MEDIUM")
  const [dueAt, setDueAt] = useState("")
  const [assigneeId, setAssigneeId] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // Overdue is a clock comparison, and this panel server-renders before it
  // hydrates: the server would decide on ITS clock and the browser on its own,
  // so a task due near now — or merely a browser a few minutes skewed — flips
  // the label and icon between the two renders and React throws a hydration
  // mismatch. Staying null until mounted makes the first client render match
  // the server's exactly; the real answer lands a tick later.
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => setNow(Date.now()), [])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    // Say why nothing happened. Returning silently leaves the Save button
    // looking broken.
    if (!title.trim()) {
      setError("Give the task a title")
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/agent-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "Lead",
          entityId: leadId,
          title,
          priority,
          // datetime-local yields wall-clock with no zone. The browser is on
          // SAST and the server is UTC, so sending it bare would shift the due
          // time by two hours — toISOString() pins the instant the user meant.
          dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
          assigneeId: assigneeId || undefined,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? "Could not create the task")
        return
      }
      setShowForm(false)
      setTitle("")
      setDueAt("")
      setAssigneeId("")
      setPriority("MEDIUM")
      router.refresh()
      onChanged?.()
    } catch {
      setError("Could not create the task")
    } finally {
      setSaving(false)
    }
  }

  const handleComplete = async (task: LeadTask) => {
    setBusyId(task.id)
    setError(null)
    try {
      const res = await fetch(`/api/agent-tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "COMPLETED" }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? "Could not complete the task")
        return
      }
      router.refresh()
      onChanged?.()
    } catch {
      setError("Could not complete the task")
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-100 shadow-sm">
      <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
        <h2 className="font-semibold text-gray-900 text-sm">Tasks</h2>
        {canCreate && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="text-xs font-medium px-3 py-1.5 rounded-md text-white"
            style={{ backgroundColor: "#4338CA" }}
          >
            + Add Task
          </button>
        )}
      </div>

      {showForm && canCreate && (
        <form onSubmit={handleCreate} className="px-5 py-4 border-b border-gray-50 bg-gray-50 space-y-3">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Task *</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={MAX_TASK_TITLE}
              className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none"
              placeholder="e.g. Call back about payslips"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Priority</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
                className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm bg-white focus:outline-none"
              >
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Due</label>
              <input
                type="datetime-local"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Assignee</label>
              <select
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm bg-white focus:outline-none"
              >
                <option value="">Unassigned</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>{s.name ?? s.email}</option>
                ))}
              </select>
            </div>
          </div>
          {/* A reminder only exists if there is both a due time and someone to
              send it to — say so rather than let staff assume it will nag.
              "after", never "when": the reminder is a scheduled sweep, so it
              lands on the next cron tick, not on the stroke of the due time.
              "when" would promise a punctuality the code does not have. */}
          <p className="text-[11px] text-gray-500">
            {dueAt && assigneeId
              ? "The assignee will be reminded after this task falls due — in their notifications, and by WhatsApp or email."
              : "Set a due time and an assignee to have a reminder sent after it falls due."}
          </p>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-1.5 rounded-md text-white text-sm font-medium disabled:opacity-60"
              style={{ backgroundColor: "#4338CA" }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-3 py-1.5 rounded-md border border-gray-200 text-sm text-gray-600"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && !showForm && <p className="px-5 pt-3 text-xs text-red-600">{error}</p>}

      <div className="divide-y divide-gray-50">
        {tasks.length === 0 && !showForm && (
          <p className="px-5 py-8 text-center text-sm text-gray-400">No open tasks for this lead</p>
        )}
        {tasks.map((task) => {
          const overdue = now !== null && isTaskOverdue(task, now)
          const ps = PRIORITY_STYLE[task.priority] ?? PRIORITY_STYLE.MEDIUM
          // The assignment is the authorisation: your own task is yours to
          // close, whoever you are. Otherwise the cron nags you about work the
          // API would refuse from you. Mirrors PATCH exactly: canManage OR own.
          // `currentUserId` may be "" if the session had no id — that matches
          // no cuid, so the button falls closed rather than open.
          const canComplete = canManage || (!!currentUserId && task.assignee?.id === currentUserId)
          return (
            <div key={task.id} className="px-5 py-3 flex items-start gap-3">
              {canComplete ? (
                <button
                  onClick={() => handleComplete(task)}
                  disabled={busyId === task.id}
                  aria-label={`Complete task: ${task.title}`}
                  className="mt-0.5 text-gray-300 hover:text-emerald-600 transition-colors disabled:opacity-50"
                >
                  {/* Never show a tick as the pending state — the row would read
                      as already completed while the request is still in flight,
                      and as not-completed again if it fails. */}
                  {busyId === task.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                </button>
              ) : (
                <Square className="h-4 w-4 mt-0.5 text-gray-200" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm text-gray-900">{task.title}</p>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span
                    className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold"
                    style={{ backgroundColor: ps.bg, color: ps.text }}
                  >
                    {task.priority}
                  </span>
                  {task.dueAt && (
                    <span className={`inline-flex items-center gap-1 text-[11px] ${overdue ? "text-red-600 font-semibold" : "text-gray-500"}`}>
                      {overdue ? <AlertTriangle className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                      {overdue ? "Overdue" : "Due"} {formatDateTime(task.dueAt)}
                    </span>
                  )}
                  {task.assignee && (
                    <span className="text-[11px] text-gray-400">
                      {task.assignee.name ?? task.assignee.email}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

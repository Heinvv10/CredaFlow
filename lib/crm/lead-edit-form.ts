// Form state + PATCH payload assembly for the lead edit modal.
//
// Prisma-free on purpose: the modal is a client component, so everything it
// imports is bundled for the browser (see lib/crm/lead-assignment.ts for the
// same rule).
//
// `buildLeadPatch` emits ONLY the fields the user actually changed. That is
// load-bearing, not cosmetic:
// - PATCH /api/crm/leads/[id] unconditionally rejects `status: "CONVERTED"`
//   (convert flow only) and `status: "LOST"` without a lostReason — a form
//   that resent its unchanged status could never save a CONVERTED or LOST
//   lead's other fields.
// - a stored assignedToId can point at a deactivated user; resending it
//   unchanged fails the route's isAssignableStaff check and blocks the save.
// - resending unchanged fields is how two concurrent editors silently revert
//   each other; omitting them narrows the write to what was touched.

// Stages a plain field-save may set. CONVERTED and LOST are deliberately
// absent: CONVERTED must go through the convert flow (it creates a Client)
// and LOST needs a lostReason — neither is a plain field edit.
export const EDITABLE_STAGES = ["NEW", "CONTACTED", "QUALIFIED", "PROPOSAL_SENT"] as const

export type LeadEditSource = {
  firstName: string
  lastName: string
  email: string | null
  phone: string
  status: string
  assignedToId: string | null
  requestedAmount: number | null
  notes: string | null
}

export type LeadFormState = {
  firstName: string
  lastName: string
  email: string
  phone: string
  status: string
  assignedToId: string
  requestedRand: string
  notes: string
}

export function leadToFormState(lead: LeadEditSource): LeadFormState {
  return {
    firstName: lead.firstName,
    lastName: lead.lastName,
    email: lead.email ?? "",
    phone: lead.phone,
    status: lead.status,
    assignedToId: lead.assignedToId ?? "",
    // requestedAmount is stored in CENTS; the form edits whole rands.
    requestedRand: lead.requestedAmount !== null ? String(Math.round(lead.requestedAmount / 100)) : "",
    notes: lead.notes ?? "",
  }
}

export function isLeadFormDirty(initial: LeadFormState, form: LeadFormState): boolean {
  return (Object.keys(initial) as (keyof LeadFormState)[]).some((k) => initial[k] !== form[k])
}

export type LeadPatch =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string }

export function buildLeadPatch(initial: LeadFormState, form: LeadFormState): LeadPatch {
  const payload: Record<string, unknown> = {}
  if (form.firstName !== initial.firstName) {
    const v = form.firstName.trim()
    if (v === "") return { ok: false, error: "First name cannot be empty." }
    payload.firstName = v
  }
  if (form.lastName !== initial.lastName) {
    const v = form.lastName.trim()
    if (v === "") return { ok: false, error: "Last name cannot be empty." }
    payload.lastName = v
  }
  if (form.phone !== initial.phone) {
    const v = form.phone.trim()
    if (v === "") return { ok: false, error: "Phone cannot be empty." }
    payload.phone = v
  }
  if (form.email !== initial.email) {
    const v = form.email.trim()
    payload.email = v === "" ? null : v
  }
  if (form.status !== initial.status) {
    if (!(EDITABLE_STAGES as readonly string[]).includes(form.status)) {
      return { ok: false, error: "That stage change needs the full page (convert / mark lost)." }
    }
    payload.status = form.status
  }
  if (form.assignedToId !== initial.assignedToId) payload.assignedToId = form.assignedToId
  if (form.requestedRand !== initial.requestedRand) {
    const t = form.requestedRand.trim()
    if (t === "") {
      payload.requestedAmount = null
    } else {
      const n = Number(t)
      if (!Number.isFinite(n)) return { ok: false, error: "Requested amount must be a number." }
      if (n < 0) return { ok: false, error: "Requested amount cannot be negative." }
      // whole rands typed in the form → cents stored on the Lead
      payload.requestedAmount = Math.round(n * 100)
    }
  }
  if (form.notes !== initial.notes) payload.notes = form.notes.trim() === "" ? null : form.notes
  return { ok: true, payload }
}

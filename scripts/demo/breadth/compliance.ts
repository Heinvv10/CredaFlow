/**
 * The compliance desk's year, through the Compliance screens' routes:
 *
 *   - complaints (POST/PATCH /api/complaints, LOAN_ADMIN+): logged, acknowledged
 *     (UNDER_INVESTIGATION), then resolved with an outcome, escalated to the
 *     ombud, or still open;
 *   - POPIA data-subject requests (POST/PATCH /api/dsar, ADMIN): an access
 *     request fulfilled after the officer pulls the client's documents (each
 *     GET /api/documents/[id]/view writes the DocumentAccessLog row), a
 *     correction, a deletion refused under the NCA retention duty, one open;
 *   - the breach register (POST/PATCH /api/compliance/breach-log): a misdirected
 *     e-mail, contained and resolved (not reportable);
 *   - conflict-of-interest declarations (POST /api/users/[id]/coi, each person
 *     for themselves), FAIS fit-and-proper records (PUT …/fit-and-proper, ADMIN)
 *     and the quarterly TCF outcomes (POST /api/compliance/tcf).
 */
import type { SimClient } from "../sim/api"
import { log } from "../sim/env"
import { addDays, shiftBusinessDays } from "../simulate/dates"
import { afterOrigination, as, beforeEnd, clientOf, fromStart, recall, remember, step, type Breadth } from "./context"

interface Complaint {
  key: string
  personaId: string
  day: (b: Breadth) => string
  category: string
  description: string
  /** [business days after logging, PATCH body] */
  updates: ReadonlyArray<readonly [number, Record<string, unknown>]>
}

const COMPLAINTS: readonly Complaint[] = [
  { key: "C1", personaId: "bg-16", day: (b) => afterOrigination(b, "bg-16", 30), category: "FEES_AND_CHARGES",
    description: "Client paid by EFT on time but the payment did not show on the account and she received an arrears reminder.",
    updates: [[1, { status: "UNDER_INVESTIGATION" }],
      [5, { status: "RESOLVED", outcome: "UPHELD", resolution: "EFT located on the bank statement without a reference and allocated to the loan; reminder withdrawn and an apology sent." }]] },
  { key: "C2", personaId: "bg-21", day: (b) => beforeEnd(b, 28), category: "COLLECTIONS_CONDUCT",
    description: "Client says collections staff phoned his workplace repeatedly about the missed instalment.",
    updates: [[2, { status: "UNDER_INVESTIGATION" }],
      [12, { status: "RESOLVED", outcome: "NOT_UPHELD", resolution: "Call log reviewed: two calls to the client's own mobile within permitted hours; no workplace calls. Explained to the client." }]] },
  { key: "C3", personaId: "bg-25", day: (b) => beforeEnd(b, 12), category: "CREDIT_AGREEMENT",
    description: "Client disputes the arrears amount stated in the Section 129 notice.",
    updates: [[1, { status: "UNDER_INVESTIGATION" }], [4, { status: "ESCALATED_OMBUD" }]] },
  { key: "C4", personaId: "bg-09", day: (b) => afterOrigination(b, "bg-09", 14), category: "DATA_PRIVACY",
    description: "Client received an e-mail meant for another client (statement reminder).",
    updates: [[1, { status: "UNDER_INVESTIGATION" }],
      [6, { status: "RESOLVED", outcome: "PARTIALLY_UPHELD", resolution: "Template merge fault; the other client's data was limited to name and reference. Breach logged, template fixed." }],
      [10, { status: "CLOSED" }]] },
  { key: "C5", personaId: "bg-13", day: (b) => beforeEnd(b, 2), category: "SERVICE_QUALITY",
    description: "Client waited three days for a settlement figure by e-mail.", updates: [] },
]

function scheduleComplaints(b: Breadth): void {
  COMPLAINTS.forEach((c, i) => {
    const chain = `complaint-${c.key}`
    // Alternately the branch manager and the collections manager own the complaint.
    const handler = async (): Promise<SimClient> => (i % 2 === 0 ? as(b, "branchManager") : b.sim.actors.loanAdmin)
    const day0 = c.day(b)
    step(b, chain, "log", day0, "11:40", async () => {
      const res = await b.sim.actors.loanAdmin.post<{ id: string; reference: string }>("/api/complaints", {
        clientId: clientOf(b, c.personaId), category: c.category, description: c.description,
        assignedToId: (await handler()).user?.id,
      }, { expect: [201] })
      if (!res.json?.id) throw new Error(`complaint create returned no id: ${res.text.slice(0, 200)}`)
      remember(b, chain, res.json.id)
    })
    c.updates.forEach(([offset, body], k) => {
      step(b, chain, `update-${k}`, shiftBusinessDays(day0, offset), "14:10", async () => {
        await (await handler()).patch(`/api/complaints/${recall(b, chain)}`, body)
      })
    })
  })
}

/** The officer pulls up the client's documents for the access request (each view is logged). */
async function viewClientDocuments(officer: SimClient, clientId: string): Promise<number> {
  const docs = (await officer.get<Array<{ id: string }>>(`/api/clients/${clientId}/documents`)).json ?? []
  for (const d of docs.slice(0, 4)) await officer.get(`/api/documents/${d.id}/view`, { headers: { accept: "*/*" } })
  return Math.min(docs.length, 4)
}

interface Dsar {
  key: string
  personaId: string
  day: (b: Breadth) => string
  type: string
  description: string
  updates: ReadonlyArray<readonly [number, Record<string, unknown>, boolean?]>
}

const DSARS: readonly Dsar[] = [
  { key: "D1", personaId: "bg-04", day: (b) => beforeEnd(b, 40), type: "ACCESS", description: "Client asked for a copy of all personal information held, after settling the loan.",
    updates: [[2, { status: "IN_PROGRESS" }, true], [7, { status: "COMPLETED", response: "Copy of the client file (ID, payslip, statements, agreement, payment history) sent by secure e-mail." }]] },
  { key: "D2", personaId: "bg-31", day: (b) => beforeEnd(b, 25), type: "DELETION", description: "Declined applicant asked for his information to be deleted.",
    updates: [[3, { status: "REFUSED", response: "Records of a credit application must be kept for the NCA retention period (Reg. 55); deletion refused, processing restricted." }]] },
  { key: "D3", personaId: "bg-12", day: (b) => afterOrigination(b, "bg-12", 25), type: "CORRECTION", description: "Client moved house and asked for the postal address to be corrected.",
    updates: [[2, { status: "COMPLETED", response: "Address updated on the client record; confirmation sent." }]] },
  { key: "D4", personaId: "bg-34", day: (b) => beforeEnd(b, 1), type: "OBJECTION", description: "Applicant objects to direct marketing.", updates: [] },
]

function scheduleDsars(b: Breadth): void {
  for (const d of DSARS) {
    const chain = `dsar-${d.key}`
    const day0 = d.day(b)
    step(b, chain, "log", day0, "10:50", async () => {
      const res = await b.sim.actors.admin.post<{ id: string }>("/api/dsar", { clientId: clientOf(b, d.personaId), type: d.type, description: d.description }, { expect: [201] })
      if (!res.json?.id) throw new Error(`DSAR create returned no id: ${res.text.slice(0, 200)}`)
      remember(b, chain, res.json.id)
    })
    d.updates.forEach(([offset, body, pullDocs], k) => {
      step(b, chain, `update-${k}`, shiftBusinessDays(day0, offset), "15:05", async () => {
        // The credit officer compiles the file: document access is staff-role
        // gated (lib/document-auth.ts STAFF_ROLES) and does not include ADMIN.
        if (pullDocs) log(`dsar ${d.key}: ${await viewClientDocuments(b.sim.actors.officer, clientOf(b, d.personaId))} document(s) viewed`)
        await b.sim.actors.admin.patch(`/api/dsar/${recall(b, chain)}`, body)
      })
    })
  }
}

function scheduleBreach(b: Breadth): void {
  const day0 = afterOrigination(b, "bg-09", 15)
  step(b, "breach-B1", "log", day0, "12:20", async () => {
    const res = await b.sim.actors.loanAdmin.post<{ id: string }>("/api/compliance/breach-log", {
      incidentDate: addDays(day0, -2), discoveredDate: addDays(day0, -1),
      description: "Statement reminder e-mail merged with another client's name and loan reference (template fault).",
      affectedClients: 1, dataCategories: "Name, loan reference",
      containmentAction: "Template disabled; recipient asked to delete the e-mail and confirmed deletion.", reportedToIC: false,
    }, { expect: [200, 201] })
    if (!res.json?.id) throw new Error(`breach log create returned no id: ${res.text.slice(0, 200)}`)
    remember(b, "breach-B1", res.json.id)
  })
  step(b, "breach-B1", "contained", shiftBusinessDays(day0, 1), "09:35", () =>
    b.sim.actors.loanAdmin.patch(`/api/compliance/breach-log/${recall(b, "breach-B1")}`, { status: "CONTAINED" }).then(() => undefined))
  step(b, "breach-B1", "resolved", shiftBusinessDays(day0, 6), "09:35", () =>
    b.sim.actors.loanAdmin.patch(`/api/compliance/breach-log/${recall(b, "breach-B1")}`, {
      status: "RESOLVED", containmentAction: "Template fixed and tested; one client affected, low risk; not notifiable to the Information Regulator.",
    }).then(() => undefined))
}

function scheduleDeclarations(b: Breadth): void {
  step(b, "coi", "declarations", fromStart(b, 1), "16:00", async () => {
    const a = b.sim.actors
    const people: Array<[SimClient, string | null]> = [
      [a.admin, null], [a.officer, null], [a.loanAdmin, null], [await as(b, "officer2"), null],
      [await as(b, "insurance"), "Spouse is a broker consultant at Umoya Life (the panel insurer); recuses herself from claims assessment."],
      [await as(b, "branchManager"), null],
    ]
    for (const [c, conflict] of people) {
      await c.post(`/api/users/${c.user?.id}/coi`, { year: 2026, hasConflict: conflict !== null, details: conflict ?? undefined }, { expect: [200, 201] })
    }
  })
  step(b, "fit-and-proper", "records", fromStart(b, 2), "16:10", async () => {
    for (const key of ["insurance", "officer2", "branchManager"] as const) {
      const id = (await as(b, key)).user?.id
      await b.sim.actors.admin.put(`/api/users/${id}/fit-and-proper`, {
        reExamType: key === "insurance" ? "RE5" : "RE1", reExamPassDate: "2024-08-15", licenceNumber: `FAIS-REP-${key === "insurance" ? "1042" : key === "officer2" ? "1043" : "1044"}`,
        licenceExpiry: "2027-08-31", cpdHoursRequired: 18, cpdHoursCompleted: key === "insurance" ? 12 : 6, cpdPeriodEnd: "2027-05-31",
        notes: "Verified against the FSCA representative register.",
      })
    }
  })
}

/** Each quarter whose TCF review falls inside the window, signed off on the 4th business day after quarter end. */
function scheduleTcf(b: Breadth): void {
  for (const [period, quarterEnd] of [["2026-Q2", "2026-06-30"], ["2026-Q3", "2026-09-30"]] as const) {
    const day = shiftBusinessDays(quarterEnd, 4)
    if (day < b.sim.window.start) continue
    step(b, "tcf", period, day, "15:45", async () => {
      await (await as(b, "branchManager")).post("/api/compliance/tcf", {
        period, outcome1: true, outcome2: true, outcome3: true, outcome4: period === "2026-Q3", outcome5: true, outcome6: true,
        notes: period === "2026-Q2"
          ? "Outcome 4 not met: two complaints about unallocated EFTs; reconciliation process changed."
          : "All six outcomes met; complaint volumes down; collections calls monitored.",
      }, { expect: [200, 201] })
    })
  }
}

export function scheduleCompliance(b: Breadth): void {
  scheduleDeclarations(b)
  scheduleComplaints(b)
  scheduleDsars(b)
  scheduleBreach(b)
  scheduleTcf(b)
}

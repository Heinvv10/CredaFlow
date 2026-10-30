import { describe, expect, it, vi } from "vitest"
import type { ChangeRequest } from "@prisma/client"
import type { ChangeHandler } from "./types"

const h = vi.hoisted(() => ({ handlers: {} as Record<string, unknown> }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("./handlers", () => ({ handlerFor: (kind: string) => h.handlers[kind] ?? null, registeredKinds: () => Object.keys(h.handlers) }))

import { candidateKinds, maySeeRow, presentChangeRequest } from "./http"

const handler = (over: Partial<ChangeHandler<{ amount: number }>>): ChangeHandler<{ amount: number }> => ({
  kind: "K", label: "A change", payloadVersion: 1, makePermission: "manage_decision_rules", approvePermission: "approve_decision_rules",
  parse: (raw) => raw as { amount: number }, apply: async () => undefined, ...over,
})
const row = (over: Partial<ChangeRequest> = {}) => ({ id: "r", kind: "K", status: "SUBMITTED", makerId: "maker", payload: { amount: 5 }, title: "t", ...over }) as ChangeRequest

describe("the routes' view of change requests", () => {
  it("lists a kind for a role that can make it or approve it, and only those", () => {
    h.handlers = { K: handler({}), ONLY_ADMIN: handler({ kind: "ONLY_ADMIN", makePermission: "delete_client", approvePermission: "delete_client" }) }
    expect(candidateKinds("LOAN_ADMIN")).toEqual(["K"])
    expect(candidateKinds("ADMIN").sort()).toEqual(["K", "ONLY_ADMIN"])
    expect(candidateKinds("CREDIT_OFFICER")).toEqual([])
  })

  it("keeps a kind whose approval permission depends on the payload in the candidates, and settles it per row", () => {
    h.handlers = { K: handler({ makePermission: "delete_client", approvePermission: (p) => (p.amount > 10 ? "delete_client" : "disburse_loan") }) }
    expect(candidateKinds("LOAN_ADMIN")).toEqual(["K"])
    expect(maySeeRow("LOAN_ADMIN", row({ payload: { amount: 5 } } as never))).toBe(true)
    expect(maySeeRow("LOAN_ADMIN", row({ payload: { amount: 50 } } as never))).toBe(false)
  })

  it("hides a request whose kind is not registered", () => {
    h.handlers = {}
    expect(maySeeRow("SUPER_ADMIN", row())).toBe(false)
  })

  it("offers Approve only to a different person who holds the approve permission for this payload", () => {
    h.handlers = { K: handler({}) }
    expect(presentChangeRequest(row(), "someone", "ADMIN")).toMatchObject({ mine: false, canApprove: true })
    expect(presentChangeRequest(row(), "maker", "ADMIN")).toMatchObject({ mine: true, canApprove: false })
    expect(presentChangeRequest(row(), "someone", "LOAN_ADMIN").canApprove).toBe(false)
    expect(presentChangeRequest(row({ status: "APPROVED" } as never), "someone", "ADMIN").canApprove).toBe(false)
  })

  it("a stored payload the handler can no longer read is approvable by nobody", () => {
    h.handlers = { K: handler({ parse: () => { throw new Error("old format") } }) }
    expect(presentChangeRequest(row(), "someone", "SUPER_ADMIN").canApprove).toBe(false)
  })
})

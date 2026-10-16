import { describe, expect, it, vi } from "vitest"
import { itemEnabled } from "@/components/app-shell/AppSidebar"
import { staffNavigation } from "@/lib/navigation"
import { ROLE_HIERARCHY, hasMinRole, type UserRole } from "@/lib/permissions"
import { isLoanBookPath, lacksLoanBook } from "./loan-book-scope"

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("next/navigation", () => ({ usePathname: () => "/" }))
import { canDo as serverCanDo } from "@/lib/auth-guards"

const items = staffNavigation.flatMap((g) => g.items)

describe("view_loan_book and act_on_collections", () => {
  it("take the loan book from INSURANCE_OFFICER only", () => {
    for (const role of ROLE_HIERARCHY) {
      expect([role, serverCanDo(role, "view_loan_book")]).toEqual([role, role !== "INSURANCE_OFFICER"])
      expect([role, lacksLoanBook(role)]).toEqual([role, role === "INSURANCE_OFFICER"])
    }
    for (const other of ["CLIENT", "OPERATOR_ADMIN", "OPERATOR_SUPPORT", undefined]) expect(lacksLoanBook(other)).toBe(false)
  })

  it("keep the COLLECTIONS_OFFICER ladder for collections actions, minus INSURANCE_OFFICER", () => {
    for (const role of ROLE_HIERARCHY) {
      const expected = role !== "INSURANCE_OFFICER" && hasMinRole(role, "COLLECTIONS_OFFICER")
      expect([role, serverCanDo(role, "act_on_collections")]).toEqual([role, expected])
    }
  })
})

describe("the sidebar for INSURANCE_OFFICER", () => {
  const visible = (role: UserRole) => items.filter((i) => itemEnabled(i, role)).map((i) => i.href)

  it("offers nothing of the loan book", () => {
    const shown = visible("INSURANCE_OFFICER")
    expect(shown.filter(isLoanBookPath)).toEqual([])
    expect(shown).toEqual(expect.arrayContaining(["/clients", "/insurance", "/insurance/claims", "/compliance", "/settings/security"]))
    for (const href of ["/dashboard", "/applications", "/loans", "/payments", "/collections", "/reports/board-pack", "/asset-finance/deals", "/crm"]) {
      expect(shown).not.toContain(href)
    }
  })

  it("leaves every other role's sidebar as it was", () => {
    for (const role of ROLE_HIERARCHY.filter((r) => r !== "INSURANCE_OFFICER")) {
      expect(visible(role)).toEqual(items.filter((i) => !i.minRole || hasMinRole(role, i.minRole)).map((i) => i.href))
    }
  })
})

describe("isLoanBookPath matches as the router does", () => {
  it.each([
    ["/api/loans", true], ["/api/loans/", true], ["/api//loans/x", true], ["//api/loans", true], ["/api/%6Coans", true],
    ["/api/./loans", true], ["/api/x/../loans", true], ["/api/%E0%A4%A", true],
    ["/api/loansx", false], ["/api/Loans", false], ["/api/clients/loans", false], ["/api", false],
    ["/loans", true], ["/loans//x/", true], ["/loansx", false], ["/clients/loans", false], ["/", false],
  ])("%s → %s", (path, expected) => {
    expect(isLoanBookPath(path)).toBe(expected)
  })
})

describe("client redaction", () => {
  it("removes the loan-book relations and figures and keeps the client", async () => {
    const { clientWithoutLoanBook, clientRelationsWithoutLoanBook } = await import("./client-redaction")
    const client = { id: "c1", firstName: "Lerato", applications: [1], loans: [1], expenseBreakdown: {}, debtObligations: [1], monthlyIncome: 1, creditScore: 600 }
    expect(clientWithoutLoanBook(client)).toEqual({ id: "c1", firstName: "Lerato" })
    expect(clientRelationsWithoutLoanBook(client)).toMatchObject({ applications: [], loans: [], debtObligations: [], expenseBreakdown: null, firstName: "Lerato" })
  })
})


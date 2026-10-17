import { expect, it, vi } from "vitest"
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
import { endExtension } from "./lease-end-of-term"
it("refuses a historical client notice before writing or querying the lease", async () => {
  const result = await endExtension({} as never, { tenantId: "synthetic-tenant", clientId: "synthetic-client" }, { loanId: "synthetic-loan", noticeOn: "2026-08-01", today: "2026-10-17" })
  expect(result).toMatchObject({ kind: "refused", reason: "invalid_notice_date" })
})

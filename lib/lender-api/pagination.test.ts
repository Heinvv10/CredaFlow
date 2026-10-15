import { describe, expect, it } from "vitest"
import { encodeCursor, pageOf, pageQuery, pageWhere, parsePageParams } from "./pagination"

const url = (q: string) => new URL(`http://localhost/api/v1/loans${q}`)
const row = { id: "loan_b_123", createdAt: new Date("2026-10-01T08:00:00.000Z") }

describe("keyset pagination", () => {
  it("round-trips a cursor into a filter on the caller's rows, never a row lookup", () => {
    const p = parsePageParams(url(`?limit=2&cursor=${encodeCursor(row)}`))
    if (p instanceof Response) throw new Error("unexpected 400")
    expect(p.after).toEqual(row)
    expect(pageWhere(p)).toEqual({ OR: [{ createdAt: { lt: row.createdAt } }, { createdAt: row.createdAt, id: { lt: row.id } }] })
    // A Prisma `cursor: { id }` reads the named row without the tenant filter.
    expect(pageQuery(p)).not.toHaveProperty("cursor")
    expect(pageQuery(p)).not.toHaveProperty("skip")
  })

  it.each(["?limit=0", "?limit=201", "?limit=x", "?cursor=!!", `?cursor=${Buffer.from("not-a-date|x").toString("base64url")}`, `?cursor=${Buffer.from(`${row.createdAt.toISOString()}|a|b`).toString("base64url")}`])(
    "answers 400 for %s",
    (q) => {
      const p = parsePageParams(url(q))
      expect(p instanceof Response && p.status).toBe(400)
    },
  )

  it("gives the next cursor only when another page follows", () => {
    const p = { limit: 1, after: null }
    const rows = [{ id: "b", createdAt: row.createdAt }, { id: "a", createdAt: row.createdAt }]
    expect(pageOf(rows, p, (r) => r.id)).toEqual({ data: ["b"], nextCursor: encodeCursor(rows[0]) })
    expect(pageOf(rows.slice(0, 1), p, (r) => r.id).nextCursor).toBeNull()
  })
})

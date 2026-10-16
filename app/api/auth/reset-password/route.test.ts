import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findUnique: h.findUnique, update: h.update } } }))
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn(async () => "hashed") } }))

import { POST } from "./route"

const post = (password: string) => POST(new NextRequest("https://app.example.test/api/auth/reset-password", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: "t".repeat(64), password }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  h.findUnique.mockResolvedValue({ id: "u1", active: true, resetTokenExp: new Date(Date.now() + 60_000) })
})

describe("POST /api/auth/reset-password (staff)", () => {
  it.each(["synth-8c", "password12", "qwerty12345"])("refuses the weak password %s and changes nothing", async (password) => {
    const res = await post(password)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/at least 10 characters|too common/)
    expect(h.update).not.toHaveBeenCalled()
  })

  it("accepts a long, uncommon password", async () => {
    const res = await post("Mango-Taxi-Umbrella")
    expect(res.status).toBe(200)
    expect(h.update).toHaveBeenCalledOnce()
  })
})

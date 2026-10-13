/** The vision reader: JSON page → cents, page combining, and the fetch contract. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MAX_CENTS } from "./money"
import { combinePages, parsePage, readWithVlm, STATEMENT_PAGE_PROMPT, VlmUnavailableError } from "./vlm-reader"
import type { StatementRead } from "./types"

const ENV_KEYS = ["VLM_API_URL", "VLM_MODEL"] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  process.env.VLM_API_URL = "http://vlm.test.invalid"
  process.env.VLM_MODEL = "synthetic-model"
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.unstubAllGlobals()
})

function okResponse(page: Record<string, unknown> | string) {
  const content = typeof page === "string" ? page : JSON.stringify(page)
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }
}

const emptyRead = (over: Partial<StatementRead> = {}): StatementRead => ({
  accountHolderName: null, accountNumberLast4: null, periodStart: null, periodEnd: null,
  openingBalanceCents: null, closingBalanceCents: null, transactions: [], ...over,
})

describe("parsePage", () => {
  it("maps rands to rounded cents and keeps the page number", () => {
    const r = parsePage({
      accountHolderName: " T TESTER ",
      openingBalance: 2345.67,
      closingBalance: 0.29,
      transactions: [
        { date: "2026-07-02", description: "SYNTH MART", amount: -845.5, balance: 1500.17 },
        { date: "2026-07-03", description: "ROUND", amount: 19.99, balance: null },
        { date: "2026-07-04", description: "FLOAT", amount: 1.15, balance: 0.1 + 0.2 },
      ],
    }, 3)
    expect(r.accountHolderName).toBe("T TESTER")
    expect(r.openingBalanceCents).toBe(234_567)
    expect(r.closingBalanceCents).toBe(29)
    expect(r.transactions.map((t) => [t.amountCents, t.balanceCents, t.page])).toEqual([
      [-84_550, 150_017, 3], [1_999, null, 3], [115, 30, 3],
    ])
  })

  it("drops rows with a non-ISO date or a non-number amount", () => {
    const r = parsePage({
      transactions: [
        { date: "02/07/2026", description: "BAD DATE", amount: 1 },
        { date: "2026-07-02", description: "STRING AMOUNT", amount: "12.00" },
        { date: "2026-07-02", description: "NULL AMOUNT", amount: null },
        { date: "2026-07-02", description: "NAN", amount: Number.NaN },
        { description: "NO DATE", amount: 5 },
        { date: "2026-07-02", description: "GOOD", amount: 5 },
      ],
    }, 1)
    expect(r.transactions.map((t) => t.description)).toEqual(["GOOD"])
  })

  it("takes the last four digits of an account number with spaces", () => {
    expect(parsePage({ accountNumber: "0000 0000 0123 4567" }, 1).accountNumberLast4).toBe("4567")
    expect(parsePage({ accountNumber: "12" }, 1).accountNumberLast4).toBeNull()
  })

  it("nulls a non-ISO period and keeps an ISO one", () => {
    const bad = parsePage({ periodStart: "01/07/2026", periodEnd: "July 2026" }, 1)
    expect(bad.periodStart).toBeNull()
    expect(bad.periodEnd).toBeNull()
    const good = parsePage({ periodStart: "2026-07-01", periodEnd: "2026-09-30" }, 1)
    expect([good.periodStart, good.periodEnd]).toEqual(["2026-07-01", "2026-09-30"])
  })

  it("rejects an amount whose cents exceed MAX_CENTS", () => {
    const tooBig = (MAX_CENTS + 100) / 100
    const atMax = MAX_CENTS / 100
    const r = parsePage({
      openingBalance: tooBig,
      closingBalance: -tooBig,
      transactions: [
        { date: "2026-07-02", description: "HUGE", amount: tooBig },
        { date: "2026-07-02", description: "HUGE NEG", amount: -tooBig },
        { date: "2026-07-02", description: "AT MAX", amount: atMax, balance: tooBig },
      ],
    }, 1)
    expect(r.openingBalanceCents).toBeNull()
    expect(r.closingBalanceCents).toBeNull()
    expect(r.transactions.map((t) => t.description)).toEqual(["AT MAX"])
    expect(r.transactions[0].amountCents).toBe(MAX_CENTS)
    expect(r.transactions[0].balanceCents).toBeNull()
  })
})

describe("combinePages", () => {
  const tx = (description: string, page: number) => ({ date: "2026-07-02", description, amountCents: 100, balanceCents: null, page })

  it("takes header facts from the first page that has them", () => {
    const c = combinePages([
      emptyRead(),
      emptyRead({ accountHolderName: "FIRST", periodStart: "2026-07-01", openingBalanceCents: 500 }),
      emptyRead({ accountHolderName: "SECOND", periodStart: "2026-08-01", openingBalanceCents: 900, accountNumberLast4: "1111" }),
    ])
    expect(c).toMatchObject({ accountHolderName: "FIRST", periodStart: "2026-07-01", openingBalanceCents: 500, accountNumberLast4: "1111" })
  })

  it("takes the closing balance from the last page that has one", () => {
    const c = combinePages([
      emptyRead({ closingBalanceCents: 100 }),
      emptyRead({ closingBalanceCents: 200 }),
      emptyRead(),
    ])
    expect(c.closingBalanceCents).toBe(200)
  })

  it("keeps an opening balance of zero rather than skipping it", () => {
    const c = combinePages([emptyRead({ openingBalanceCents: 0 }), emptyRead({ openingBalanceCents: 700 })])
    expect(c.openingBalanceCents).toBe(0)
  })

  it("concatenates transactions in page order with their page numbers", () => {
    const c = combinePages([
      emptyRead({ transactions: [tx("A", 1), tx("B", 1)] }),
      emptyRead({ transactions: [tx("C", 2)] }),
    ])
    expect(c.transactions.map((t) => [t.description, t.page])).toEqual([["A", 1], ["B", 1], ["C", 2]])
  })
})

describe("readWithVlm", () => {
  const images = [Buffer.from("page-one"), Buffer.from("page-two")]

  it("makes one request per image carrying the model, a data URL and the prompt", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse({ accountHolderName: "T TESTER", openingBalance: 100, transactions: [{ date: "2026-07-02", description: "A", amount: -1.5, balance: 98.5 }] }))
      .mockResolvedValueOnce(okResponse({ closingBalance: 98.5, transactions: [{ date: "2026-07-03", description: "B", amount: 0, balance: 98.5 }] }))
    vi.stubGlobal("fetch", fetchMock)

    const read = await readWithVlm(images, "image/jpeg")

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("http://vlm.test.invalid/v1/chat/completions")
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe("synthetic-model")
    const content = body.messages[0].content
    expect(content[0]).toEqual({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${images[0].toString("base64")}` } })
    expect(content[1]).toEqual({ type: "text", text: STATEMENT_PAGE_PROMPT })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).messages[0].content[0].image_url.url)
      .toBe(`data:image/jpeg;base64,${images[1].toString("base64")}`)
    expect(read).toMatchObject({ accountHolderName: "T TESTER", openingBalanceCents: 10_000, closingBalanceCents: 9_850 })
    expect(read!.transactions.map((t) => [t.description, t.page])).toEqual([["A", 1], ["B", 2]])
  })

  it("tolerates a fenced JSON answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse("```json\n{\"openingBalance\": 5}\n```")))
    const read = await readWithVlm([images[0]], "image/png")
    expect(read?.openingBalanceCents).toBe(500)
  })

  it("returns null when no page yields rows or an opening balance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse({ closingBalance: 10, accountHolderName: "T TESTER", transactions: [] })))
    expect(await readWithVlm(images, "image/jpeg")).toBeNull()
  })

  it("returns null when the answer is not JSON at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse("I cannot read this image")))
    expect(await readWithVlm([images[0]], "image/jpeg")).toBeNull()
  })

  it("throws VlmUnavailableError on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }))
    await expect(readWithVlm(images, "image/jpeg")).rejects.toThrow(VlmUnavailableError)
    await expect(readWithVlm(images, "image/jpeg")).rejects.toThrow("503")
  })

  it("throws VlmUnavailableError when the request itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect refused")))
    const err = await readWithVlm(images, "image/jpeg").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VlmUnavailableError)
    expect((err as Error).message).toContain("connect refused")
  })

  it("throws VlmUnavailableError, without calling fetch, when VLM_API_URL is unset", async () => {
    delete process.env.VLM_API_URL
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(readWithVlm(images, "image/jpeg")).rejects.toThrow(VlmUnavailableError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LABEL_BACKOFF_MS, NEVER_APPLIED, runOrder, vote, VOTE_RUNS, LABEL_KEY_MAX, labelKey, labelKeys, labelPrompt, LABEL_BATCH, MODEL_CATEGORIES, MODEL_LABEL_PROMPT_VERSION, modelLabelFor, needsModelLabels, parseLabels, resetModelLabelBackoff, MODEL_LABELS } from "./model-labels"
import { VlmUnavailableError } from "./vlm-reader"

const answer = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
/** The same answer to every request (each of the VOTE_RUNS runs). */
const always = (fetchMock: ReturnType<typeof vi.fn>, content: string) => fetchMock.mockImplementation(async () => answer(content))

describe("labelKey", () => {
  it("is the masked counterparty key: three words, no digits, no amounts", () => {
    expect(labelKey("Card Purchase: SYNTH GROCER 4411 SOWETO ZA")).toBe("SYNTH GROCER SOWETO")
    expect(labelKey("PAYMENT TO REF 123456")).toBe("PAYMENT TO REF")
  })

  it("is bounded", () => {
    expect(labelKey(`Card Purchase: ${"Z".repeat(60_000)}`)).toHaveLength(LABEL_KEY_MAX)
  })
})

describe("modelLabelFor", () => {
  it("returns a stored category for the row's key", () => {
    expect(modelLabelFor({ "SYNTH GROCER SOWETO": "FOOD" }, "Card Purchase: SYNTH GROCER 4411 SOWETO")).toBe("FOOD")
  })

  it.each([
    ["an off-enum value", { "SYNTH GROCER SOWETO": "GROCERIES" }],
    ["an income category the model may not give", { "SYNTH GROCER SOWETO": "SALARY_INCOME" }],
    ["a stored credit instalment (never applied)", { "SYNTH GROCER SOWETO": "CREDIT_INSTALMENT" }],
    ["a stored gambling label (never applied)", { "SYNTH GROCER SOWETO": "GAMBLING" }],
    ["UNCATEGORISED", { "SYNTH GROCER SOWETO": "UNCATEGORISED" }],
    ["a non-string", { "SYNTH GROCER SOWETO": 7 }],
    ["no labels", null],
    ["an array", ["FOOD"]],
    ["another key only", { "OTHER SHOP": "FOOD" }],
  ])("is null for %s", (_, labels) => {
    expect(modelLabelFor(labels, "Card Purchase: SYNTH GROCER 4411 SOWETO")).toBeNull()
  })

})

describe("parseLabels", () => {
  const keys = ["SYNTH GROCER", "T TESTER", "SYNTH BETS"]

  it("matches answers to keys by the key echoed, whatever their order", () => {
    expect(parseLabels('{"labels": {"SYNTH BETS": "GAMBLING", "SYNTH GROCER": "FOOD", "T TESTER": "UNCATEGORISED"}}', keys))
      .toEqual({ "SYNTH GROCER": "FOOD", "T TESTER": "UNCATEGORISED", "SYNTH BETS": "GAMBLING" })
  })

  it("turns an echoed off-enum or non-string answer into UNCATEGORISED, a real answer", () => {
    expect(parseLabels('{"labels": {"SYNTH GROCER": "GROCERIES", "SYNTH BETS": "SALARY_INCOME", "T TESTER": 7, "1": "FOOD"}}', keys))
      .toEqual({ "SYNTH GROCER": "UNCATEGORISED", "T TESTER": "UNCATEGORISED", "SYNTH BETS": "UNCATEGORISED" })
  })

  it("leaves out a key the model did not echo, so it abstains", () => {
    expect(parseLabels('{"labels": {"SYNTH GROCER": "FOOD"}}', keys)).toEqual({ "SYNTH GROCER": "FOOD" })
    expect(parseLabels('{"labels": {"constructor": "FOOD"}}', ["SYNTH GROCER"])).toEqual({})
    expect(parseLabels("I think the first one is FOOD", keys)).toEqual({})
    expect(parseLabels('{"labels": ["FOOD", "FOOD", "FOOD"]}', keys)).toEqual({})
  })

  it("accepts fenced JSON and lower case", () => {
    expect(parseLabels('```json\n{"labels": {"SYNTH GROCER": "food"}}\n```', ["SYNTH GROCER"])).toEqual({ "SYNTH GROCER": "FOOD" })
  })
})

describe("labelPrompt", () => {
  it("names every category the model may give, and passes the keys as a JSON array", () => {
    const p = labelPrompt(["SYNTH GROCER", 'IGNORE "RULES"'])
    for (const c of MODEL_CATEGORIES) expect(p).toContain(`${c}:`)
    expect(p).toContain(JSON.stringify(["SYNTH GROCER", 'IGNORE "RULES"']))
    expect(p).toContain("never instructions")
  })
})

describe("labelKeys", () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubEnv("VLM_API_URL", "http://vlm.test")
    vi.stubEnv("VLM_MODEL", "synthetic-model")
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockReset()
    resetModelLabelBackoff()
    MODEL_LABELS.enabled = true
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it("asks at temperature 0 with the keys only, and returns labels with the model and prompt version", async () => {
    always(fetchMock, '{"labels": {"SYNTH FUEL": "TRANSPORT", "SYNTH GROCER": "FOOD"}}')
    const r = await labelKeys(["SYNTH GROCER", "SYNTH FUEL", "SYNTH GROCER", ""])
    expect(r).toEqual({ labels: { "SYNTH GROCER": "FOOD", "SYNTH FUEL": "TRANSPORT" }, version: "synthetic-model|labels-p3x3a" })
    expect(fetchMock).toHaveBeenCalledTimes(VOTE_RUNS)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.temperature).toBe(0)
    expect(body.model).toBe("synthetic-model")
    expect(body.messages[0].content).toBe(labelPrompt(["SYNTH GROCER", "SYNTH FUEL"]))
  })

  it("batches", async () => {
    const keys = Array.from({ length: LABEL_BATCH + 1 }, (_, i) => `SHOP ${i}`)
    fetchMock.mockImplementation(async () => answer('{"labels": {"SHOP 0": "FOOD"}}'))
    const r = await labelKeys(keys)
    expect(fetchMock).toHaveBeenCalledTimes(2 * VOTE_RUNS)
    expect(Object.keys(r.labels)).toHaveLength(keys.length)
  })

  it("stores garbage as UNCATEGORISED", async () => {
    fetchMock.mockImplementation(async () => new Response("<html>oops</html>", { status: 200 }))
    expect((await labelKeys(["SYNTH GROCER"])).labels).toEqual({ "SYNTH GROCER": "UNCATEGORISED" })
  })

  it.each([
    ["not configured", () => vi.stubEnv("VLM_API_URL", "")],
    ["down", () => fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))],
    ["timed out", () => fetchMock.mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"))],
    ["an HTTP error", () => fetchMock.mockResolvedValueOnce(new Response("busy", { status: 503 }))],
  ])("throws VlmUnavailableError when the model is %s", async (_, arrange) => {
    arrange()
    await expect(labelKeys(["SYNTH GROCER"])).rejects.toBeInstanceOf(VlmUnavailableError)
  })

  it("backs off after the model could not be asked: no request, and no read needs labels, until the backoff ends", async () => {
    const unlabelled = { status: "READ", modelCategoriesVersion: null }
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000)
    fetchMock.mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"))
    await expect(labelKeys(["SYNTH GROCER"])).rejects.toBeInstanceOf(VlmUnavailableError)
    expect(needsModelLabels(unlabelled)).toBe(false)
    await expect(labelKeys(["SYNTH GROCER"])).rejects.toBeInstanceOf(VlmUnavailableError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    now.mockReturnValue(1_000_000 + LABEL_BACKOFF_MS)
    expect(needsModelLabels(unlabelled)).toBe(true)
    always(fetchMock, '{"labels": {"SYNTH GROCER": "FOOD"}}')
    expect((await labelKeys(["SYNTH GROCER"])).labels).toEqual({ "SYNTH GROCER": "FOOD" })
  })

  it.each([400, 413, 422])("a batch the model refuses (%s) is UNCATEGORISED and backs nothing off", async (status) => {
    const unlabelled = { status: "READ", modelCategoriesVersion: null }
    fetchMock.mockImplementation(async () => new Response("maximum context length", { status }))
    expect((await labelKeys(["SYNTH HUGE"])).labels).toEqual({ "SYNTH HUGE": "UNCATEGORISED" })
    expect(needsModelLabels(unlabelled)).toBe(true)
    always(fetchMock, '{"labels": {"SYNTH GROCER": "FOOD"}}')
    expect((await labelKeys(["SYNTH GROCER"])).labels).toEqual({ "SYNTH GROCER": "FOOD" })
  })

  it.each([401, 403, 404, 408, 429, 503])("a %s is the model or its setup being unavailable: back off, store nothing", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"The model `synthetic-model` does not exist."}', { status }))
    await expect(labelKeys(["SYNTH GROCER"])).rejects.toBeInstanceOf(VlmUnavailableError)
    expect(needsModelLabels({ status: "READ", modelCategoriesVersion: null })).toBe(false)
  })

  it("throws when any batch fails, so a partial set is never stored", async () => {
    const keys = Array.from({ length: LABEL_BATCH + 1 }, (_, i) => `SHOP ${i}`)
    fetchMock.mockResolvedValueOnce(answer('{"labels": {"SYNTH GROCER": "FOOD"}}')).mockRejectedValueOnce(new TypeError("fetch failed"))
    await expect(labelKeys(keys)).rejects.toBeInstanceOf(VlmUnavailableError)
  })
})

describe("vote", () => {
  const runs = (...cats: string[]) => cats.map((c) => ({ K: c })) as Parameters<typeof vote>[0]

  it("keeps a living category only when every run gave it", () => {
    expect(vote(runs("FOOD", "FOOD", "FOOD"), ["K"])).toEqual({ K: "FOOD" })
    expect(vote(runs("FOOD", "FOOD", "UNCATEGORISED"), ["K"])).toEqual({ K: "UNCATEGORISED" })
    expect(vote(runs("FOOD", "FOOD", "CLOTHING"), ["K"])).toEqual({ K: "UNCATEGORISED" })
  })

  it("keeps any other category on a majority", () => {
    expect(vote(runs("BANK_FEES", "BANK_FEES", "UNCATEGORISED"), ["K"])).toEqual({ K: "BANK_FEES" })
    expect(vote(runs("BANK_FEES", "CASH_WITHDRAWAL", "UNCATEGORISED"), ["K"])).toEqual({ K: "UNCATEGORISED" })
    expect(vote(runs("BANK_FEES", "BANK_FEES", "CASH_WITHDRAWAL", "SAVINGS_INVESTMENT", "UNCATEGORISED"), ["K"])).toEqual({ K: "UNCATEGORISED" })
  })

  it.each(NEVER_APPLIED)("never keeps %s, even unanimous", (c) => {
    expect(vote(runs(c, c, c), ["K"])).toEqual({ K: "UNCATEGORISED" })
  })

  it("leaves out a run that abstained, but needs answers from a majority of VOTE_RUNS", () => {
    expect(vote([{ K: "FOOD" }, {}, { K: "FOOD" }], ["K"])).toEqual({ K: "FOOD" })
    expect(vote([{ K: "FOOD" }, {}, {}], ["K"])).toEqual({ K: "UNCATEGORISED" })
    expect(vote([{ K: "BANK_FEES" }, {}, {}], ["K"])).toEqual({ K: "UNCATEGORISED" })
    expect(vote([], ["K"])).toEqual({ K: "UNCATEGORISED" })
  })

  it("never returns an inherited property for a key", () => {
    expect(vote([{}, {}, {}], ["constructor"])).toEqual({ constructor: "UNCATEGORISED" })
  })
})

describe("runOrder", () => {
  const keys = Array.from({ length: 30 }, (_, i) => `SHOP ${i}`)
  it("asks every key in every run, in a repeatable order that differs between runs", () => {
    const orders = Array.from({ length: VOTE_RUNS }, (_, r) => runOrder(keys, r))
    for (const o of orders) expect([...o].sort()).toEqual([...keys].sort())
    expect(new Set(orders.map((o) => o.join("|"))).size).toBe(VOTE_RUNS)
    expect(runOrder(keys, 1)).toEqual(runOrder(keys, 1))
  })
})

describe("labelKeys votes", () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubEnv("VLM_API_URL", "http://vlm.test")
    vi.stubEnv("VLM_MODEL", "synthetic-model")
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockReset()
    resetModelLabelBackoff()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it("asks VOTE_RUNS times and stores a living label only when every run agrees", async () => {
    fetchMock
      .mockResolvedValueOnce(answer('{"labels": {"SYNTH GROCER": "FOOD", "SYNTH PAY": "FOOD"}}'))
      .mockResolvedValueOnce(answer('{"labels": {"SYNTH GROCER": "FOOD", "SYNTH PAY": "UNCATEGORISED"}}'))
      .mockResolvedValueOnce(answer('{"labels": {"SYNTH GROCER": "FOOD", "SYNTH PAY": "FOOD"}}'))
    expect((await labelKeys(["SYNTH GROCER", "SYNTH PAY"])).labels).toEqual({ "SYNTH GROCER": "FOOD", "SYNTH PAY": "UNCATEGORISED" })
    expect(fetchMock).toHaveBeenCalledTimes(VOTE_RUNS)
  })

  it("a run that leaves a key out of its labels abstains for it, not a vote against", async () => {
    fetchMock
      .mockResolvedValueOnce(answer('{"labels": {"SYNTH GROCER": "FOOD", "SYNTH PAY": "FOOD"}}'))
      .mockResolvedValueOnce(answer('{"labels": {"SYNTH PAY": "FOOD"}}'))
      .mockResolvedValueOnce(answer('{"labels": {"SYNTH GROCER": "FOOD", "SYNTH PAY": "GROCERIES"}}'))
    // SYNTH GROCER: FOOD, omitted, FOOD → FOOD. SYNTH PAY: FOOD, FOOD, and an echoed invalid value → a vote for UNCATEGORISED.
    expect((await labelKeys(["SYNTH GROCER", "SYNTH PAY"])).labels).toEqual({ "SYNTH GROCER": "FOOD", "SYNTH PAY": "UNCATEGORISED" })
  })

  it("never stores a credit instalment or gambling, however sure the model is", async () => {
    always(fetchMock, '{"labels": {"SYNTH PAY": "CREDIT_INSTALMENT", "SYNTH BET": "GAMBLING"}}')
    expect((await labelKeys(["SYNTH PAY", "SYNTH BET"])).labels).toEqual({ "SYNTH PAY": "UNCATEGORISED", "SYNTH BET": "UNCATEGORISED" })
  })

  it.each([
    ["refused (413)", () => new Response("", { status: 413 })],
    ["answered with garbage", () => answer("sorry")],
  ])("a run whose batch is %s abstains: the other runs' unanimous living label stands", async (_, bad) => {
    let n = 0
    fetchMock.mockImplementation(async () => (++n === 2 ? bad() : answer('{"labels": {"SYNTH GROCER": "FOOD"}}')))
    expect((await labelKeys(["SYNTH GROCER"])).labels).toEqual({ "SYNTH GROCER": "FOOD" })
  })

  it("asks each run in its own order (runOrder), so batches differ between runs", async () => {
    const keys = Array.from({ length: LABEL_BATCH + 1 }, (_, i) => `SHOP ${i}`)
    always(fetchMock, '{"labels": {}}')
    await labelKeys(keys)
    const sent = fetchMock.mock.calls.map(([, init]) => JSON.parse(JSON.parse(init.body).messages[0].content.split("Items (JSON array):\n")[1]) as string[])
    for (let run = 0; run < VOTE_RUNS; run++) {
      const order = runOrder(keys, run)
      expect(sent.slice(2 * run, 2 * run + 2)).toEqual([order.slice(0, LABEL_BATCH), order.slice(LABEL_BATCH)])
    }
  })

  it("one key that makes its batch fail costs its neighbours little: a batch abstains, it does not vote UNCATEGORISED", async () => {
    const keys = ["SYNTH POISON", ...Array.from({ length: 2 * LABEL_BATCH }, (_, i) => `SHOP ${i}`)]
    fetchMock.mockImplementation(async (_u: string, init: { body: string }) => {
      const ks = JSON.parse(JSON.parse(init.body).messages[0].content.split("Items (JSON array):\n")[1]) as string[]
      return ks.includes("SYNTH POISON") ? answer("garbage") : answer(JSON.stringify({ labels: Object.fromEntries(ks.map((k) => [k, "FOOD"])) }))
    })
    const r = await labelKeys(keys)
    expect(keys.filter((k) => k !== "SYNTH POISON" && r.labels[k] !== "FOOD").length).toBeLessThan(LABEL_BATCH)
  })

  it("throws when a later run fails, so a partial vote is never stored", async () => {
    fetchMock.mockResolvedValueOnce(answer('{"labels": {"SYNTH GROCER": "FOOD"}}')).mockRejectedValueOnce(new TypeError("fetch failed"))
    await expect(labelKeys(["SYNTH GROCER"])).rejects.toBeInstanceOf(VlmUnavailableError)
  })
})

describe("MODEL_LABEL_PROMPT_VERSION names the prompt", () => {
  // A changed prompt or category set changes stored labels' meaning: bump the version (reads are relabelled), then re-pin.
  it("is bumped whenever the prompt changes", () => {
    const hash = createHash("sha256").update(JSON.stringify([labelPrompt(["SYNTH"]), MODEL_CATEGORIES, LABEL_BATCH, VOTE_RUNS, NEVER_APPLIED])).digest("hex").slice(0, 16)
    expect({ version: MODEL_LABEL_PROMPT_VERSION, hash }).toEqual({ version: "labels-p3x3a", hash: "d748ec68260c1212" })
  })
})

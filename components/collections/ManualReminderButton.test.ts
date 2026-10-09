import { createElement } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import {
  defaultReminderMessage,
  ManualReminderButton,
  mayReleaseReminderOperationId,
  operationIdAfterReminderChannelSelection,
  reminderOutcomeNotice,
  unresolvedReminderChannelsAfterDeliveries,
} from "./ManualReminderButton"

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

function buttonsWithText(renderer: ReactTestRenderer, text: string) {
  return renderer.root.findAllByType("button").filter((button) => {
    const children = Array.isArray(button.props.children)
      ? button.props.children
      : [button.props.children]
    return children.some((child: unknown) => child === text)
  })
}

describe("defaultReminderMessage — staff reminder pre-fill quotes the loan reference", () => {
  // The loan reference (Loan.reference) is the token the bank-sync reconciler
  // EXACT-matches on. The staff-editable default reminder pre-fills it so the
  // client is told which reference to quote when they pay.
  it("includes the loan reference", () => {
    expect(defaultReminderMessage("Thabo Mokoena", "LN-0007")).toContain("LN-0007")
  })

  it("greets the client by first name only", () => {
    const msg = defaultReminderMessage("Thabo Mokoena", "LN-0007")
    expect(msg).toContain("Thabo")
    expect(msg).not.toContain("Mokoena")
  })
})

describe("reminderOutcomeNotice — preserves every channel outcome", () => {
  it.each([
    [
      [{ channel: "SMS", outcome: "sent" }, { channel: "WhatsApp", outcome: "blocked", detail: "opted out" }],
      ["SMS: sent", "WhatsApp: blocked (opted out)"],
    ],
    [
      [{ channel: "SMS", outcome: "simulated" }, { channel: "WhatsApp", outcome: "reconciliation_required" }],
      ["SMS: simulated", "WhatsApp: reconciliation required"],
    ],
    [
      [{ channel: "SMS", outcome: "sent" }, { channel: "WhatsApp", outcome: "pending" }],
      ["SMS: sent", "WhatsApp: pending"],
    ],
  ] as const)("reports a mixed result without hiding either leg", (deliveries, expected) => {
    const notice = reminderOutcomeNotice([...deliveries])
    expect(notice.level).toBe("warning")
    for (const text of expected) expect(notice.detail).toContain(text)
  })

  it("releases the protected operation id only when every requested leg was sent", () => {
    expect(mayReleaseReminderOperationId([{ channel: "SMS", outcome: "sent" }])).toBe(true)
    expect(mayReleaseReminderOperationId([
      { channel: "SMS", outcome: "sent" },
      { channel: "WhatsApp", outcome: "pending" },
    ])).toBe(false)
    expect(mayReleaseReminderOperationId([{ channel: "SMS", outcome: "simulated" }])).toBe(true)
    expect(mayReleaseReminderOperationId([])).toBe(false)
  })

  it("preserves the protected key across channel narrowing and expansion", () => {
    expect(operationIdAfterReminderChannelSelection("operation-1", "both", "both")).toBe("operation-1")
    expect(operationIdAfterReminderChannelSelection("operation-1", "both", "sms")).toBe("operation-1")
    expect(operationIdAfterReminderChannelSelection("operation-1", "sms", "whatsapp")).toBe("operation-1")
    expect(operationIdAfterReminderChannelSelection(null, "sms", "both")).toBeNull()
  })

  it("keeps the unresolved SMS reservation after a mixed both-channel outcome", () => {
    const deliveries = [
      { channel: "SMS", outcome: "reconciliation_required" as const },
      { channel: "WhatsApp", outcome: "sent" as const },
    ]

    expect(mayReleaseReminderOperationId(deliveries)).toBe(false)
    expect(operationIdAfterReminderChannelSelection("operation-mixed", "both", "sms"))
      .toBe("operation-mixed")
  })

  it.each([
    ["SMS", "WhatsApp"],
    ["WhatsApp", "SMS"],
  ] as const)("does not let a later %s-only success erase the unresolved %s leg", (sentChannel, unresolvedChannel) => {
    const mixed = unresolvedReminderChannelsAfterDeliveries([], [
      { channel: sentChannel, outcome: "sent" },
      { channel: unresolvedChannel, outcome: "reconciliation_required" },
    ])
    expect(mixed).toEqual([unresolvedChannel])

    const subsetReplay = [{ channel: sentChannel, outcome: "sent" as const }]
    expect(unresolvedReminderChannelsAfterDeliveries(mixed, subsetReplay)).toEqual([unresolvedChannel])
    expect(mayReleaseReminderOperationId(subsetReplay, mixed)).toBe(false)

    const resolvedReplay = [{ channel: unresolvedChannel, outcome: "sent" as const }]
    expect(unresolvedReminderChannelsAfterDeliveries(mixed, resolvedReplay)).toEqual([])
    expect(mayReleaseReminderOperationId(resolvedReplay, mixed)).toBe(true)
  })
})

describe("ManualReminderButton protected mixed-channel replay", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it.each([
    {
      unresolved: "SMS",
      successful: "WhatsApp",
      successfulSelector: "WhatsApp",
    },
    {
      unresolved: "WhatsApp",
      successful: "SMS",
      successfulSelector: "SMS",
    },
  ] as const)(
    "reuses the group operation after $unresolved is uncertain and only $successful is replayed",
    async ({ unresolved, successful, successfulSelector }) => {
      const randomUUID = vi.fn()
        .mockReturnValueOnce("operation-mixed")
        .mockReturnValueOnce("operation-new")
      vi.stubGlobal("crypto", { randomUUID })
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            deliveries: [
              { channel: unresolved, outcome: "reconciliation_required", messageId: "uncertain-1" },
              { channel: successful, outcome: "sent", messageId: "sent-1" },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            deliveries: [{ channel: successful, outcome: "sent", messageId: "sent-1" }],
          }),
        })
      vi.stubGlobal("fetch", fetchMock)

      let renderer!: ReactTestRenderer
      await act(async () => {
        renderer = create(createElement(ManualReminderButton, {
          loanId: "loan-1",
          clientName: "Synthetic Client",
          clientPhone: "+27820000000",
          loanReference: "LOAN-1",
        }))
      })

      await act(async () => { buttonsWithText(renderer, "Send Reminder")[0].props.onClick() })
      await act(async () => { buttonsWithText(renderer, "SMS + WhatsApp")[0].props.onClick() })
      await act(async () => {
        const sendButtons = buttonsWithText(renderer, "Send Reminder")
        await sendButtons.at(-1)!.props.onClick()
      })

      await act(async () => { buttonsWithText(renderer, "Send Reminder")[0].props.onClick() })
      await act(async () => { buttonsWithText(renderer, successfulSelector)[0].props.onClick() })
      await act(async () => {
        const sendButtons = buttonsWithText(renderer, "Send Reminder")
        await sendButtons.at(-1)!.props.onClick()
      })

      expect(fetchMock).toHaveBeenCalledTimes(2)
      const requestBodies = fetchMock.mock.calls.map(([, init]) =>
        JSON.parse(String((init as RequestInit).body)) as {
          channel: string
          operationId: string
        },
      )
      expect(requestBodies).toEqual([
        { channel: "both", message: expect.any(String), operationId: "operation-mixed" },
        {
          channel: successfulSelector.toLowerCase(),
          message: expect.any(String),
          operationId: "operation-mixed",
        },
      ])
      expect(randomUUID).toHaveBeenCalledOnce()
      await act(async () => renderer.unmount())
    },
  )
})

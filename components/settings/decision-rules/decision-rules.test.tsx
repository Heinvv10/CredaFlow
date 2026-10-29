// @vitest-environment jsdom
// The builder offers only operators that fit a fact's type, and the approvals
// list offers Approve to an approver who did not draft the change, never to its maker.
import { act, create } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FACT_DEFINITIONS, FACT_NAMES } from "@/lib/decisioning/facts"
import type { Node } from "@/lib/decisioning/types"
import { ChangeRequestsPanel } from "./ChangeRequestsPanel"
import { ConditionTree } from "./ConditionTree"
import type { ChangeRow, FactOption } from "./types"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const facts: FactOption[] = FACT_NAMES.map((name) => ({ name, ...FACT_DEFINITIONS[name] }))

afterEach(() => { delete actEnvironment.IS_REACT_ACT_ENVIRONMENT })

async function mount(element: React.ReactElement) {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let renderer!: ReturnType<typeof create>
  await act(async () => { renderer = create(element) })
  return renderer
}

const optionsOf = (r: ReturnType<typeof create>, label: string) =>
  r.root.findAll((n) => n.type === "select" && n.props["aria-label"] === label)[0].findAllByType("option").map((o) => o.props.value as string)

describe("ConditionTree", () => {
  it("offers comparison operators for a number fact and only is/is-not for a yes/no fact", async () => {
    const number = await mount(<ConditionTree node={{ field: "bureauScore", op: "lt", value: 500 }} facts={facts} onChange={() => undefined} />)
    expect(optionsOf(number, "Operator")).toEqual(expect.arrayContaining(["gt", "between", "isNull"]))
    const yesNo = await mount(<ConditionTree node={{ field: "bureauJudgement", op: "eq", value: true }} facts={facts} onChange={() => undefined} />)
    expect(optionsOf(yesNo, "Operator")).toEqual(["eq", "neq"])
  })

  it("adding a condition to a group reports a group with one more entry", async () => {
    const onChange = vi.fn()
    const node: Node = { all: [{ field: "bureauScore", op: "lt", value: 500 }] }
    const r = await mount(<ConditionTree node={node} facts={facts} onChange={onChange} />)
    const add = r.root.findAll((n) => n.type === "button" && n.children.includes("Add condition"))[0]
    await act(async () => { add.props.onClick() })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect((onChange.mock.calls[0][0] as { all: Node[] }).all).toHaveLength(2)
  })
})

const request = (over: Partial<ChangeRow>): ChangeRow => ({
  id: "cr1", kind: "DECISION_RULE_SET", label: "Decision rule set", title: "Tighten", status: "SUBMITTED",
  payload: { name: "Baseline", rules: [{}], scorecard: null, effectiveFrom: "2026-11-01", challengerOnly: false },
  decisionNote: null, createdAt: "2026-10-29T08:00:00Z", mine: false, canApprove: true, ...over,
})
const buttons = (r: ReturnType<typeof create>) => r.root.findAllByType("button").map((b) => b.children.join(""))

describe("ChangeRequestsPanel", () => {
  it("an approver who did not draft it sees Approve and Reject", async () => {
    const r = await mount(<ChangeRequestsPanel requests={[request({})]} onEdit={() => undefined} onDone={() => undefined} />)
    expect(buttons(r)).toEqual(expect.arrayContaining(["Approve", "Reject"]))
  })

  it("the maker sees Withdraw and the reason they cannot approve, never Approve", async () => {
    const r = await mount(<ChangeRequestsPanel requests={[request({ mine: true, canApprove: false })]} onEdit={() => undefined} onDone={() => undefined} />)
    expect(buttons(r)).toContain("Withdraw")
    expect(buttons(r)).not.toContain("Approve")
    expect(JSON.stringify(r.toJSON())).toContain("you cannot approve your own change")
  })
})

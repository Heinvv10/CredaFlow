// @vitest-environment jsdom
// Text fields that keep what the person is typing until it parses, instead of
// turning a cleared box into 0 or a half-typed list into a different list.
import { act, create } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ListField, NumberField } from "./fields"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
afterEach(() => { delete actEnvironment.IS_REACT_ACT_ENVIRONMENT })

async function mount(element: React.ReactElement) {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let renderer!: ReturnType<typeof create>
  await act(async () => { renderer = create(element) })
  return renderer
}
const input = (r: ReturnType<typeof create>) => r.root.findByType("input")
const type = async (r: ReturnType<typeof create>, value: string) => act(async () => { input(r).props.onChange({ target: { value } }) })
const blur = async (r: ReturnType<typeof create>) => act(async () => { input(r).props.onBlur() })

describe("NumberField", () => {
  it("commits a typed number as it parses", async () => {
    const onChange = vi.fn()
    const r = await mount(<NumberField label="Cap" value={5} onChange={onChange} />)
    await type(r, "12")
    expect(onChange).toHaveBeenLastCalledWith(12)
  })

  it("clearing the box commits nothing (it is not 0) and keeps the empty text until blur, which restores the last value", async () => {
    const onChange = vi.fn()
    const r = await mount(<NumberField label="Cap" value={5} onChange={onChange} />)
    await type(r, "")
    expect(onChange).not.toHaveBeenCalled()
    expect(input(r).props.value).toBe("")
    await blur(r)
    expect(input(r).props.value).toBe("5")
  })

  it("a half-typed minus or a non-number is not committed", async () => {
    const onChange = vi.fn()
    const r = await mount(<NumberField label="Cap" value={5} onChange={onChange} />)
    await type(r, "-")
    await type(r, "abc")
    expect(onChange).not.toHaveBeenCalled()
  })

  it("keeps 0 as a real value", async () => {
    const onChange = vi.fn()
    const r = await mount(<NumberField label="Cap" value={5} onChange={onChange} />)
    await type(r, "0")
    expect(onChange).toHaveBeenLastCalledWith(0)
  })
})

describe("ListField", () => {
  it("keeps the text as typed (a trailing comma too) and parses it on blur", async () => {
    const onChange = vi.fn()
    const r = await mount(<ListField label="Values" value={["A"]} parse={(s) => s} onChange={onChange} />)
    await type(r, "A, B,")
    expect(onChange).not.toHaveBeenCalled()
    expect(input(r).props.value).toBe("A, B,")
    await blur(r)
    expect(onChange).toHaveBeenCalledWith(["A", "B"])
  })

  it("parses numbers for a number fact", async () => {
    const onChange = vi.fn()
    const r = await mount(<ListField label="Values" value={[1]} parse={Number} onChange={onChange} />)
    await type(r, "1, 2 ,3")
    await blur(r)
    expect(onChange).toHaveBeenCalledWith([1, 2, 3])
  })

  it("refuses a list with an entry that is not a number, leaving the stored list alone", async () => {
    const onChange = vi.fn()
    const r = await mount(<ListField label="Values" value={[1]} parse={Number} onChange={onChange} />)
    await type(r, "1, x")
    await blur(r)
    expect(onChange).not.toHaveBeenCalled()
    expect(input(r).props.value).toBe("1")
  })
})

import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ClientPicker } from "./ClientPicker"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const CLIENTS = [
  { id: "c1", firstName: "Lerato", lastName: "Mahlangu", email: "lerato.m@client.invalid" },
  { id: "c2", firstName: "Lerato", lastName: "Dube", email: "ldube@client.invalid" },
]

let renderer: ReactTestRenderer

function results(search: string): string[] {
  act(() => {
    renderer = create(
      <ClientPicker clients={CLIENTS} selectedClientId="" clientSearch={search} setClientSearch={() => {}} onSelect={() => {}} />,
    )
  })
  return renderer.root.findAllByType("button").map((b) => b.findAllByType("p")[0].children.join(""))
}

beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => { act(() => renderer.unmount()) })

// Fair Score audit (2026-10-16): "Lerato Mah" found nothing; only the email worked.
describe("ClientPicker search", () => {
  it("finds a client by first name and the start of the surname", () => {
    expect(results("Lerato Mah")).toEqual(["Lerato Mahlangu"])
  })

  it("still finds by a single name or the email", () => {
    expect(results("lerato")).toEqual(["Lerato Mahlangu", "Lerato Dube"])
    expect(results("ldube@")).toEqual(["Lerato Dube"])
  })
})

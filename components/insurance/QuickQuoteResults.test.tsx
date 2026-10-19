// @vitest-environment jsdom
// Fair Score audit row 117: the results list printed the insurer's scraped
// premium text ("R752.96") beside house-format money elsewhere. A priced row now
// shows the number in the house format; an unpriced row keeps their label.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QuickQuoteResults } from "./QuickQuoteResults"

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const mounted: { root: Root; container: HTMLDivElement }[] = []

function host(premiums: string[]): HTMLElement {
  const el = document.createElement("div")
  el.innerHTML = `<div class="quotes">${premiums
    .map(
      (p, i) => `<div class="dataRow">
        <div class="label"><img src="https://insurer.example/${i}.png" alt="Insurer ${i}"></div>
        <div class="excess-details"><a title="Insurer ${i}">x</a><span data-bind="OfferingId">id-${i}</span> Premium is ${p} with basic excess</div>
        <div class="rightCol"><span class="premium">${p}</span><button>Interested</button></div>
      </div>`,
    )
    .join("")}</div>`
  return el
}

async function mountResults(premiums: string[]): Promise<HTMLDivElement> {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(<QuickQuoteResults host={host(premiums)} summary={[]} onEdit={vi.fn()} onParsed={vi.fn()} panelComplete />)
  })
  return container
}

beforeEach(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  delete env.IS_REACT_ACT_ENVIRONMENT
})

describe("QuickQuoteResults money format", () => {
  it("prints a priced row's premium in the house format", async () => {
    const container = await mountResults(["R752.96", "R1240.72"])
    const prices = [...container.querySelectorAll(".cf-res-premium")].map((p) => p.textContent).join("|")
    expect(prices).toContain("R 752.96 per month")
    expect(prices).toContain("R 1,240.72 per month")
    expect(prices).not.toContain("R752.96")
  })

  it("keeps the insurer's own label when there is no number", async () => {
    const container = await mountResults(["Price on request"])
    expect(container.querySelector(".cf-res-premium")?.textContent).toBe("Price on request")
  })
})

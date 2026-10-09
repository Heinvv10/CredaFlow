import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * The site footer carries the NCR/FSP registration disclosure, and the
 * WhatsApp launcher is a `fixed` overlay that sits in the bottom-right corner
 * of every website page. If the footer's last row ends inside the strip the
 * launcher occupies, the launcher covers a regulatory disclosure.
 *
 * That is not hypothetical — it shipped. Measured on staging `79bf082c` at max
 * scroll, the launcher's ink overlapped the line
 * "Registered Credit Provider — NCR Reg: … · FSP: …" at every
 * viewport from 375px to 1440px (2px deep at 375px, 12px deep at 1024–1440px).
 *
 * The vitest harness is `environment: "node"` (no jsdom, no layout engine), so
 * this cannot be asserted geometrically. It is asserted as a cross-file
 * agreement instead: both numbers are parsed from source, so changing the
 * launcher's offset or the footer's reserve on its own fails here rather than
 * silently re-opening the overlap.
 */

const ROOT = join(__dirname, "..", "..")

/** Tailwind v4 default spacing scale: 1 unit = 0.25rem = 4px. */
const SPACING_UNIT_PX = 4
/** Tailwind v4 default `text-sm` line-height: 1.25rem. */
const TEXT_SM_LINE_HEIGHT_PX = 20
/** Breathing room between the disclosure and the launcher's top edge. */
const MIN_GAP_PX = 8

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8")
}

function matchOrThrow(source: string, pattern: RegExp, what: string): RegExpMatchArray {
  const found = source.match(pattern)
  if (!found) {
    throw new Error(
      `Could not find ${what}. This test parses source text, so a refactor that ` +
        `moves or renames it must update this parser — do not delete the assertion.`,
    )
  }
  return found
}

/** Height of the launcher's pill: py-3 top + text-sm line box + py-3 bottom. */
function launcherOccupiedHeightPx(launcherSource: string): number {
  const button = matchOrThrow(
    launcherSource,
    /rounded-full bg-\[var\(--cf-brand\)\][^"]*/,
    "the WhatsApp launcher's trigger button classes",
  )[0]

  const paddingY = matchOrThrow(button, /(?:^|\s)py-(\d+)(?:\s|$)/, "the launcher button's py-* class")
  expect(button, "the launcher button's line-height must still come from text-sm").toMatch(
    /(?:^|\s)text-sm(?:\s|$)/,
  )

  return Number(paddingY[1]) * SPACING_UNIT_PX * 2 + TEXT_SM_LINE_HEIGHT_PX
}

describe("website Footer / WhatsApp launcher clearance", () => {
  it("reserves enough bottom padding that the launcher cannot cover the NCR/FSP disclosure", () => {
    const launcher = read("components/support/WhatsAppLauncher.tsx")
    const footer = read("components/website/Footer.tsx")

    const bottomOffset = matchOrThrow(
      launcher,
      /fixed right-4 bottom-(\d+) z-40/,
      "the WhatsApp launcher's base bottom offset",
    )
    const offsetPx = Number(bottomOffset[1]) * SPACING_UNIT_PX

    // Top edge of the launcher, measured up from the bottom of the viewport.
    // Verified against the live staging render, which reported exactly 68px.
    const launcherTopFromBottomPx = offsetPx + launcherOccupiedHeightPx(launcher)

    const footerPadding = matchOrThrow(
      footer,
      /mx-auto max-w-7xl[^"]*?(?:^|\s)pb-(\d+)(?:\s|$)/,
      "the footer content wrapper's pb-* class",
    )
    const footerPaddingPx = Number(footerPadding[1]) * SPACING_UNIT_PX

    expect(
      footerPaddingPx,
      `footer reserves ${footerPaddingPx}px but the launcher's top edge sits ` +
        `${launcherTopFromBottomPx}px above the viewport bottom`,
    ).toBeGreaterThanOrEqual(launcherTopFromBottomPx + MIN_GAP_PX)
  })

  it("keeps the top padding independent of the reserved bottom strip", () => {
    // `py-12` would set BOTH edges, so growing the bottom reserve would also
    // add dead space above the footer. The two must stay separate classes.
    const footer = read("components/website/Footer.tsx")
    const wrapper = matchOrThrow(
      footer,
      /mx-auto max-w-7xl[^"]*/,
      "the footer content wrapper classes",
    )[0]

    expect(wrapper).toMatch(/(?:^|\s)pt-\d+(?:\s|$)/)
    expect(wrapper, "py-* would couple the top padding to the launcher reserve").not.toMatch(
      /(?:^|\s)py-\d+(?:\s|$)/,
    )
  })
})

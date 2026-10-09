"use client"

import { formatZAR } from "@/lib/utils"
import { buildBandGrid, type AgeRange, type GridBand } from "@/lib/insurance/rating/band-grid"
import type { RateBasis } from "@prisma/client"

/**
 * "an extended family", not "a extended family".
 *
 * Vowel-initial is the whole rule here because the labels are a closed set —
 * Main member, Spouse, Child, Extended family — with no "hour"/"university"
 * cases to trip it. If a life type is ever added, check it against this.
 */
export function indefiniteArticle(label: string): "a" | "an" {
  return /^[aeiou]/i.test(label) ? "an" : "a"
}

/**
 * The rate card as a grid, because the row-at-a-time list it is entered through
 * cannot show what is WRONG with the finished card. A hole between two age
 * bands stores, activates, and reports the product sellable; the first time
 * anyone learns of it is a quote that returns NO_MATCHING_BAND for a real
 * client. Here it is a blank cell with a warning under it.
 *
 * Which axes are drawn is the BASIS's answer — see `band-grid.ts`. A PER_MILLE
 * card is drawn with one cover column because that is how it is rated; drawing
 * a column per cover amount would show tiers the rating path does not have.
 */
export function RateBandGridView({
  basis,
  bands,
  onEditBand,
  onAddAt,
}: {
  basis: RateBasis
  bands: GridBand[]
  /** Omitted on a frozen (ACTIVE or RETIRED) card — the API refuses those edits. */
  onEditBand?: (band: GridBand) => void
  onAddAt?: (target: { lifeType: GridBand["lifeType"]; range: AgeRange | null; cover: number | null }) => void
}) {
  const grid = buildBandGrid(basis, bands)
  const editable = Boolean(onEditBand && onAddAt)

  if (grid.sections.length === 0) {
    return (
      <p className="text-sm text-gray-400 py-6 text-center">
        No bands yet. A rate table with no bands cannot be activated — it would price nothing.
      </p>
    )
  }

  return (
    <div className="space-y-6">
      {grid.sections.map((section) => (
        <div key={section.lifeType}>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
            {LIFE_TYPE_LABELS[section.lifeType]}
          </h4>
          <div className="overflow-x-auto">
            <table className="text-sm border border-gray-100 rounded-lg">
              <thead>
                <tr className="bg-gray-50/70">
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-gray-400">
                    {section.ageRanges[0] === null ? "All ages" : "Entry age"}
                  </th>
                  {section.coverTiers.map((cover, i) => (
                    <th
                      key={cover ?? `any-${i}`}
                      className="px-3 py-2 text-right text-[11px] font-semibold uppercase text-gray-400 whitespace-nowrap"
                    >
                      {cover === null ? "Any cover" : formatZAR(Math.round(cover * 100))}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {section.ageRanges.map((range, rowIndex) => (
                  <tr key={range ? `${range.minAge}-${range.maxAge}` : "any"} className="border-t border-gray-50">
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                      {range === null ? "Any age" : `${range.minAge}–${range.maxAge}`}
                    </td>
                    {section.coverTiers.map((cover, colIndex) => {
                      const cell = section.cells[rowIndex][colIndex]
                      return (
                        <td key={cover ?? `any-${colIndex}`} className="px-3 py-2 text-right tabular-nums">
                          {cell.length === 0 ? (
                            editable ? (
                              <button
                                type="button"
                                onClick={() =>
                                  onAddAt?.({ lifeType: section.lifeType, range, cover })
                                }
                                className="text-[#4F46E5] hover:underline text-xs font-medium"
                                title="No band prices this cell — add one"
                              >
                                + add
                              </button>
                            ) : (
                              <span className="text-gray-300" title="Not priced">
                                —
                              </span>
                            )
                          ) : cell.length === 1 ? (
                            editable ? (
                              <button
                                type="button"
                                onClick={() => onEditBand?.(cell[0])}
                                className="text-[#1b1d24] hover:text-[#4F46E5] hover:underline"
                              >
                                {formatZAR(Math.round(cell[0].premiumAmount * 100))}
                              </button>
                            ) : (
                              <span>{formatZAR(Math.round(cell[0].premiumAmount * 100))}</span>
                            )
                          ) : (
                            <span className="text-red-600 font-semibold" title="More than one band prices this cell">
                              {cell.map((b) => formatZAR(Math.round(b.premiumAmount * 100))).join(" / ")}
                            </span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {section.gaps.length > 0 && (
            <ul className="mt-2 text-xs text-amber-800 space-y-1">
              {/*
                One template literal rather than text interleaved with
                expressions across several lines. The JSX transform drops the
                whitespace at a line break between a text node and its
                neighbour, and that is how "does notmake anything sellable"
                can happen — invisible in source, invisible to tests that
                render the element tree, visible only in a browser.
              */}
              {section.gaps.map((gap) => (
                <li key={`${gap.sumAssured}-${gap.minAge}`}>
                  {`Ages ${gap.minAge}–${gap.maxAge} are not priced${
                    gap.sumAssured === null
                      ? ""
                      : ` at cover ${formatZAR(Math.round(gap.sumAssured * 100))}`
                  }, so a life that age cannot be quoted.`}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      {/*
        A life type with NO band is drawn as its own empty section rather than
        skipped. Skipping it is what made this the worst-hidden fault on the
        screen: a card with main-member bands and nothing for a spouse renders
        complete — every cell filled, no gap, no overlap — while `rateLife`
        returns NO_MATCHING_BAND for every spouse, because life type is the one
        key every basis matches on. The only place that surfaced was the
        readiness panel on a different screen.
      */}
      {grid.unpriceableLifeTypes.map((lifeType) => (
        <div key={lifeType}>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
            {LIFE_TYPE_LABELS[lifeType]}
          </h4>
          <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/60 px-4 py-3">
            <p className="text-sm text-amber-900">
              {/*
                The indefinite article agrees with the label. Hardcoding "a"
                renders "prices a extended family", and a test asserting that
                string would pin the defect rather than catch it.
              */}
              {`No band on this card prices ${indefiniteArticle(LIFE_TYPE_LABELS[lifeType])} ${LIFE_TYPE_LABELS[lifeType].toLowerCase()}, at any age or cover amount. A quote covering one cannot be priced at all.`}
            </p>
            {onAddAt && (
              <button
                type="button"
                onClick={() => onAddAt({ lifeType, range: null, cover: null })}
                className="mt-1 text-xs font-semibold text-[#4F46E5] hover:underline"
              >
                + add the first band for this life type
              </button>
            )}
          </div>
        </div>
      ))}

      {grid.overlaps.length > 0 && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 space-y-1">
          <p className="font-semibold">
            {`${grid.overlaps.length} pair${grid.overlaps.length === 1 ? "" : "s"} of bands price the same life, so nothing on this card can be quoted.`}
          </p>
          {grid.overlaps.map(([a, b]) => (
            <p key={`${a.id}-${b.id}`} className="text-xs">
              {`${LIFE_TYPE_LABELS[a.lifeType]} ${a.minAge}–${a.maxAge} and ${b.minAge}–${b.maxAge} both apply.`}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

export const LIFE_TYPE_LABELS: Record<GridBand["lifeType"], string> = {
  MAIN_MEMBER: "Main member",
  SPOUSE: "Spouse",
  CHILD: "Child",
  EXTENDED_FAMILY: "Extended family",
}

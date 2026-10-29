/**
 * The census of NCA-only surfaces (routes and pages), declared one file per
 * domain under lib/registry/nca-only/ and checked by nca-only-census.test.ts.
 *
 * Every entry says how a lender outside the NCA's jurisdiction is kept out:
 * - `direct`: the file itself tests `isNcaJurisdiction()` / `ncaOnlyRefusal()`.
 * - `via`: the file is gated by something it calls, named by `proof`: each
 *   `{ file, contains }` pair must hold, and a test elsewhere exercises the
 *   behaviour. A reason says why that is enough.
 */
export type NcaOnlyGate =
  | { gate: "direct" }
  | { gate: "via"; reason: string; proof: readonly { file: string; contains: string }[] }

export type NcaOnlySurfaces = Readonly<Record<string, NcaOnlyGate>>

export function defineNcaOnlySurfaces<T extends NcaOnlySurfaces>(surfaces: T): T {
  return surfaces
}

# Part W: what changed in the template fingerprints

`shape-hashes-before.json` is taken on `origin/main` at 76d67783
(SYSTEM_REVISION 2026-10-19.1) and `shape-hashes-after.json` on the
part W commit (SYSTEM_REVISION 2026-10-22.1). Each file holds, for every
asset-finance template variant, the SHA-256 of the preview PDF of every deal
shape (the inputs of the fingerprint, `templates/fingerprint.ts`) and the
fingerprint itself. The "after" file is for the final design (introducer row and fixed paragraph). Both use the fingerprint's fixed synthetic lender and
placeholder clauses.

Reproduce (needs `npm ci --legacy-peer-deps`; run from the repository root
on each commit, saving stdout):

```ts
// dump-shapes.ts, run with: npx tsx --tsconfig tsconfig.json dump-shapes.ts
import { createHash } from "node:crypto"
import { ALL_TEMPLATE_KEYS, editableClauses, parseTemplateKey, STARTER_REVISION } from "@/lib/asset-finance/documents/templates/families"
import { previewShapes, renderTemplatePreview } from "@/lib/asset-finance/documents/templates/preview"
import { systemFingerprint } from "@/lib/asset-finance/documents/templates/fingerprint"

const L = { legalName: "Fingerprint Lender (Pty) Ltd", tradingName: "Fingerprint Lender", companyRegNumber: "2000/000000/07", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Fingerprint Street", "Testville", "0000"] }
async function main() {
  const out: Record<string, unknown> = {}
  for (const k of ALL_TEMPLATE_KEYS) {
    const key = parseTemplateKey(k)!
    const content = { schema: 1 as const, templateKey: k, starterRevision: STARTER_REVISION, additionalTerms: [],
      clauses: Object.fromEntries(editableClauses(key).map((c) => [c.id, `Fingerprint placeholder for clause ${c.number}. ${c.requiredTokens.map((t) => `{{${t}}}`).join(" ")}`.trim()])) }
    const shapes: Record<string, string> = {}
    for (const s of previewShapes(k)) shapes[s.id] = createHash("sha256").update(await renderTemplatePreview(k, content, L, s.id)).digest("hex")
    out[k] = { fingerprint: await systemFingerprint(k), shapes }
  }
  process.stdout.write(JSON.stringify(out, null, 1))
}
main()
```

Result (compared shape by shape):

| Variant | Fingerprint | Shapes before | Shapes byte-identical after | Shape added |
|---|---|---|---|---|
| `af.isa.commercial` | moved | 7 | 7 of 7 | `dealer` |
| `af.isa.cpa` | moved | 7 | 7 of 7 | `dealer` |
| `af.lease.operating.commercial` | moved | 9 | 9 of 9 | `dealer` |
| `af.lease.operating.cpa` | moved | 10 | 10 of 10 | `dealer` |
| `af.lease.fml.commercial` | moved | 9 | 9 of 9 | `dealer` |
| `af.lease.fml.cpa` | moved | 10 | 10 of 10 | `dealer` |
| `af.nca.instalment_sale` | moved | 9 | 9 of 9 | `dealer` |
| `af.nca.finance_lease` | moved | 9 | 9 of 9 | `dealer` |
| `af.suretyship.commercial` | unchanged | 2 | 2 of 2 | none |
| `af.suretyship.nca` | unchanged | 2 | 2 of 2 | none |
| `af.resolution.standard` | unchanged | 5 | 5 of 5 | none |

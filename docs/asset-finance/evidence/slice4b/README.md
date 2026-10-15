# Asset finance slice 4b: accounting export UI, browser evidence

Captured 2026-10-15 from a local `next dev` on branch `feat/af-slice4-journals`, headless Chrome at
1280 px (desktop) and 390 px (mobile), light and dark. Every name and number is synthetic.

## State used

- A throwaway Postgres 16 (`scripts/it-db.sh`), `npx prisma migrate reset --force` (migrations plus the
  seed), **staff TOTP on**. Signed in as the seeded `admin@acme-lending.example` (ADMIN) with password and
  the TOTP code generated from the seeded secret (`lib/totp.ts generateTotpCode`). Passwords came from the
  `SEED_*_PASSWORD` variables for the run; none is in source.
- The seed's asset-finance contracts (two instalment sales, a finance lease, two full-maintenance leases,
  an operating lease, a recovery with proceeds applied and a listed one) were moved back 25 days by SQL
  with triggers off (test setup only), so that September 2026 has ended and holds their events. The
  go-live month is September 2026.
- Two faults were injected by SQL, one at a time, and removed again: the proceeds payment of the seeded
  recovery made R 1.00 larger than the recovery's own figures (shot 04), and the supplier payout of the
  operating lease made R 1.00 smaller than the asset costs (shot 05, a "deposit or trade-in").
- Everything else went through the screens: confirming the mapping, closing the month, downloading the CSVs.
- The Next.js dev badge was hidden by a style rule for the shots.

## Shots

Each state has `-light-desktop`, `-dark-desktop`, `-light-390` and `-dark-390`.

| # | State | What it shows |
|---|---|---|
| 01 | Mapping confirmed before asset finance existed | Settings panel: "0 of 15 confirmed" with the unconfirmed accounts named. Export panel: "The chart of accounts needs confirming", the server's sentence naming the roles beneath it, Close disabled |
| 02 | Mapping editor (light desktop only) | The "Asset finance" group of the chart of accounts; its tax-code inputs are disabled because their VAT posts on its own lines |
| 03 | After the administrator confirms from the page | "15 of 15 confirmed"; the preview of September with Close enabled |
| 04 | A check that differs | "1 asset-finance check differs" listing the recovery by contract reference with the journal's figure and the contract records'; "An asset-finance check does not agree with the contract records"; Close disabled |
| 05 | A contract the export cannot post yet | "Some asset-finance contracts cannot be exported yet" with the contract and the reason; the contract is left out of the preview and is not also listed as a failing check |
| 06 | September closed | History row (26 entries, debits equal credits), October shown as "not over yet" |
| 07 | `07-journal-2026-09-generic.csv`, `07-journal-2026-09-sage.csv` | The sealed batch: asset-finance accounts (1110, 1120, 1300, 1500, 2400, 2500, 4100, 4110, 6100, 6300...) with the Sage layout's tax-code column empty on every line |

## Notes

- At 390 px the new notices and the settings text wrap inside the page. The accounts table of the existing
  period panel scrolls inside its card (unchanged by this slice).
- The server's sentence stays under each plain-language notice, so what staff report matches the audit trail.

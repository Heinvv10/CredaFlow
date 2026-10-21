# Slice 5 part C browser acceptance: valuation guides

The seed is `lib/valuation-guides/valuation-browser-seed.test.ts`. Run it
only on a throwaway database that you own. The browser run itself is §5 C of
the goal (`.claude/handoffs/2026-10-19-asset-finance-slice5-goal.md`).

Status: the seed is written and runs green. The browser run has **not** been
done yet, and there are no screenshots in this folder.

## Seed

```bash
eval "$(bash scripts/it-db.sh up cf-it-valuation-browser-$RANDOM)"
bash scripts/it-db.sh check
npx prisma migrate deploy
VALUATION_BROWSER_SEED=1 npx vitest run lib/valuation-guides/valuation-browser-seed.test.ts
```

By default the seed writes `/tmp/cf-valuation-browser.json`; set
`VALUATION_BROWSER_SEED_OUT` to write it elsewhere. The file has mode 600 and
holds:

- the tenant's id, slug and host;
- the password, which every login uses;
- the TOTP secret, which every staff user shares;
- the staff logins:
  - `loadingAdmin` and `publishingAdmin`, two LOAN_ADMINs;
  - `creditOfficer`;
  - `readonly`;
- the deal's id and its asset;
- the lease's deal, loan and asset ids;
- the row shape the seed asserts.

Two runs on fresh databases produce the same shape:

- no guide and no valuation yet;
- an `INSTALMENT_SALE` deal in DRAFT;
- an `OPERATING_LEASE` deal BOOKED, with its loan ACTIVE;
- the assets TEST EX-1 2025 (the deal's) and TEST EX-2 2025 (the lease's);
- these roles: CREDIT_OFFICER, two LOAN_ADMINs, READONLY, and the fixture's
  SUPER_ADMIN legal approver, which has no usable password.

What the seed creates:

- A synthetic lender with asset finance on.
- The deal: R1 500 000 cash price excl. VAT plus R225 000 VAT, a R172 500
  deposit, so the goods advance is R1 552 500.
- The lease: booked today with two monthly rentals. Its end-of-term choice
  opens six months before the last rental, so it is open now.

The guide files are in `lib/valuation-guides/__fixtures__/`:

| File | What it holds |
|---|---|
| `browser-guide-valid.csv` | Five rows, including TEST EX-1 2025 (no variant, and "Long reach") and TEST EX-2 2025. |
| `browser-guide-malformed.csv` | Refused with five line reasons: line 2 decimals, line 4 a duplicate of line 3, line 5 no model and trade above retail, line 6 a formula, line 7 seven columns. `lib/valuation-guides/csv.test.ts` pins these reasons. |

## Run the app against it

```bash
DATABASE_URL=... NEXT_PUBLIC_TENANT_SLUG=<slug> AUTH_SECRET=<any local secret> \
  NEXTAUTH_URL=http://localhost:3000 npm run dev
```

`npm run dev` is not a deployed build, so the upload form offers the
synthetic provider. A production build needs
`SIMULATED_INTEGRATIONS=simulated-valuation-guide` for it. Set that on demo
stacks only, never for a real lender.

## Acceptance steps (§5 C)

1. Sign in as `loadingAdmin` (password, then TOTP). Open Asset Finance →
   Valuation guides and upload `browser-guide-malformed.csv`. It is refused
   with the five line reasons, and the list stays empty.
2. Upload `browser-guide-valid.csv` as "TEST Plant Guide", effective today or
   earlier. It shows as Draft. As the uploader you see Discard but not
   Publish. A direct POST to `…/publish` answers 403, and the refusal is
   audited.
3. Sign in as `publishingAdmin`. Open the guide, check its rows and publish
   it. It shows as Current.
4. Sign in as `creditOfficer` and open the deal. In the "Guide value" panel,
   choose the EX-1 row (no variant) and record it. The panel then shows:
   - trade R1 200 000 and retail R1 400 000;
   - a goods advance of R1 552 500;
   - LTV 129.38% against trade and 110.89% against retail.
5. Open the lease's asset (TEST EX-2) and record its guide value
   (R1 100 000 trade). Open the lease's loan page. Under End of term, elect a
   purchase on that guide valuation. It is refused with "A purchase rests on
   an assessor's or a dealer's valuation".
6. Open Valuation guides → Book revaluation. The lease's loan shows the EX-2
   row, with no LTV (a lease).
7. As `readonly`, the guide pages and the panels are visible, but there is no
   upload, publish, discard or record control.

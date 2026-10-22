# Slice 5 follow-ups part W browser acceptance: the introducer's commission disclosure

Seed: `lib/asset-finance/commission-browser-seed.test.ts`. Run it only on a
throwaway database that you own.

```bash
eval "$(bash scripts/it-db.sh up cf-it-commission-browser-$RANDOM)"
bash scripts/it-db.sh check
npx prisma migrate deploy
WCOMMISSION_BROWSER_SEED=1 npx vitest run lib/asset-finance/commission-browser-seed.test.ts
# ... browse ...
bash scripts/it-db.sh down <the name you gave up>
```

It writes `/tmp/cf-commission-browser.json` (mode 600; override with
`WCOMMISSION_BROWSER_SEED_OUT`): the lender's slug and host, the shared
password, the staff TOTP secret, two LOAN_ADMIN staff (`admin-a-<token>@staff.invalid`,
`admin-b-<token>@staff.invalid`), and four APPROVED deals with their staff
URLs (`/asset-finance/deals/<id>`):

| Deal | What | Introducer | Staff step |
|---|---|---|---|
| `isaDealer` | commercial instalment sale (a company) | SYNTHETIC Highveld Plant Dealers (Pty) Ltd, a dealer | prepare the signing documents |
| `isaPlain` | the same shape | none | prepare the signing documents |
| `ncaBroker` | NCA instalment sale (a natural person), credit life elected | SYNTHETIC Karoo Finance Brokers CC, a broker | generate the NCA quotation |
| `ncaPlain` | the same shape | none | generate the NCA quotation |

The lender is a synthetic demo lender (`isDemoLender`): its asset-finance
templates are adopted, approved and published (`ensureSyntheticTemplates`), so
documents issue under the synthetic demo watermark. The dealer and the broker
are linked to the two deals as the dealer fixtures write history (triggers
off): the deals were approved before the introducer was recorded.

The NCA agreement needs the consumer to acknowledge the quotation in the
portal, which this seed does not set up; the quotation's section is the NCA
check.

Run the app with the lender's host on `*.localhost`, as part T's README does:

```bash
SLUG=<slug from the file>
DATABASE_URL=... NEXT_PUBLIC_TENANT_SLUG=$SLUG AUTH_SECRET=<local> CRON_SECRET=<local> \
  NEXTAUTH_URL=http://staff-w.localhost:3472 STAFF_APP_HOST=staff-w.localhost \
  TENANT_HOST_MAP="staff-w.localhost=$SLUG" npx next dev -p 3472
```

Steps (goal §5 W):

1. Sign in as an admin (password, then the TOTP code). Open `isaDealer`, set
   the contract start date one month before the seeded first instalment
   (seed day + 1 month; the default, today, gives a longer term than the
   approved one and is refused with 422), prepare the signing documents, open the agreement: section 5 ends with the row
   `Introducer: <dealer> (dealer)` and the paragraph "Introducer's commission.
   …"; no clause number moved.
2. Open `isaPlain`, prepare, open the agreement: no Introducer row, no
   paragraph.
3. Open `ncaBroker`, generate the NCA quotation (the staff app has no button for
   it: `POST /api/asset-finance/deals/<id>/nca-quote` from the signed-in
   session; the document is at `/api/documents/<documentId>/view`): after the repayment schedule,
   a section "COMMISSION TO THE INTRODUCER" with the row `<broker> (broker)`
   and the paragraph; the "Total cost of credit" line is unchanged.
4. Open `ncaPlain`, generate the quotation: no such section.
5. The demo lender's templates are approved (Settings, document templates):
   every variant ACTIVE with a synthetic demo approval.

What was checked on a throwaway database before this was written: the seed
runs (4 APPROVED deals, 2 with an introducer); preparing documents for
`isaDealer` and `isaPlain` and generating the quotation for `ncaBroker` and
`ncaPlain` through the real routes print exactly the text above and nothing on
the plain deals. The pages themselves were not loaded in a browser.

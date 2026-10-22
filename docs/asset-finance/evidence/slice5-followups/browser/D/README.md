# Slice 5 follow-ups part D browser acceptance: dealer consent v2, cancel, purge

Seed: `lib/dealer/dealer-followups-browser-seed.test.ts`. Run it only on a
throwaway database that you own.

```bash
eval "$(bash scripts/it-db.sh up cf-it-dealer-followups-browser-$RANDOM)"
bash scripts/it-db.sh check
npx prisma migrate deploy
DEALER_FOLLOWUPS_BROWSER_SEED=1 npx vitest run lib/dealer/dealer-followups-browser-seed.test.ts
```

It writes `/tmp/cf-dealer-followups-browser.json` (mode 600; override with
`DEALER_FOLLOWUPS_BROWSER_SEED_OUT`): the slug, the shared password, the staff
TOTP secret, the staff (CREDIT_OFFICER, LOAN_ADMIN) and dealer users (A's
sales user and admin, B's admin), and four deals of dealer A's sales user:

| Deal | State |
|---|---|
| `consent` | DRAFT with a signed POPIA consent form uploaded |
| `cancel` | DRAFT |
| `abandoned` | DRAFT, a consent form and a bank statement, every date moved 91 days back |
| `booked` | BOOKED, moved four years back |

Run the app with two `*.localhost` hosts (Chrome resolves them locally):

```bash
SLUG=<slug from the file>
DATABASE_URL=... NEXT_PUBLIC_TENANT_SLUG=$SLUG AUTH_SECRET=<local> CRON_SECRET=<local> \
  NEXTAUTH_URL=http://staff-d.localhost:3471 STAFF_APP_HOST=staff-d.localhost DEALER_APP_HOST=dealers-d.localhost \
  TENANT_HOST_MAP="staff-d.localhost=$SLUG,dealers-d.localhost=$SLUG" npx next dev -p 3471
```

Steps (goal §5 D):

1. Dealer A sales user signs in at `dealers-d.localhost`, opens `consent`,
   picks the form and the director, chooses "Remotely", describes the identity
   check, confirms and attests (01, 02).
2. The same user cancels `cancel` with a reason (03, 04).
3. Dealer B's admin (another browser context) opens A's `consent` deal and
   POSTs `/api/dealer/deals/<id>/cancel`: page "Not found", API 404 (05).
4. The credit officer signs in at `staff-d.localhost` (password and TOTP) and
   sees the REMOTE method and identity check on `consent` (06) and the dealer's
   cancellation on `cancel` (07).
5. `curl -H "x-cron-secret: $CRON_SECRET" http://127.0.0.1:3471/api/cron/asset-finance-dealer-draft-purge`;
   the officer sees the tombstone on `abandoned` (08) and `booked` with no
   purge (09); the sales user opens `abandoned` and sees it closed, with no
   actions (10).

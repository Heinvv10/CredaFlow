# Slice 5 part B browser acceptance: telematics

The seed is `lib/telematics/telematics-browser-seed.test.ts`. Run it only on a
throwaway database that you own. The browser run itself is §5 B of the goal and
task 11 of `docs/asset-finance/SLICE5.md` part B.

## Seed

```bash
eval "$(bash scripts/it-db.sh up cf-it-telematics-browser-$RANDOM)"
bash scripts/it-db.sh check
npx prisma migrate deploy
TELEMATICS_BROWSER_SEED=1 npx vitest run lib/telematics/telematics-browser-seed.test.ts
```

Set `TELEMATICS_BROWSER_SEED_OUT` to write somewhere other than
`/tmp/cf-telematics-browser.json`. The file has mode 600 and holds:

- the tenant's id, slug and host;
- the password, which is the same for every login;
- the TOTP secret, which every staff user shares;
- the staff emails: LOAN_ADMIN, CREDIT_OFFICER, COLLECTIONS_OFFICER and
  READONLY;
- the dealer user's email (password only);
- the loan and device ids;
- the row shape the seed asserts.

Two runs on fresh databases produce the same shape: five ACTIVE simulated
devices, two operating leases, an instalment sale and the dealer's booked
deal, two start readings, no events, and the same six staff roles.

What the seed creates:

- A synthetic demo lender with the dealer portal switched on.
- Two operating leases. Each is 1 500 h a year, starts at 1 000 h, and was
  booked 30 days ago.
- An instalment sale, also booked 30 days ago.
- Three devices, each installed on its loan's start date:

  | Device | Loan |
  |---|---|
  | `SIM-TAMPER-0001` | first lease (the asset's recorded tracker id is this device's) |
  | `SIM-ROLLBACK-0002` | second lease |
  | `SIM-STEADY-0003` | instalment sale |
- A second state, written to the file as `beforePayout` and `dealerDeal`:
  - an operating lease approved and signed but not paid out, its
    TRACKER_CONFIRMED item still open, with `SIM-STEADY-0005` installed five
    days ago (polled before payout: heartbeat only, no position, no alert, no
    reading);
  - a deal captured by the seed's dealer and booked today, with
    `SIM-STEADY-0004`, for the dealer deal-view check (no telematics in it).

Nothing is polled yet.

## Run the app against it

```bash
DATABASE_URL=... NEXT_PUBLIC_TENANT_SLUG=<slug> CRON_SECRET=<any local secret> \
  AUTH_SECRET=<any local secret> NEXTAUTH_URL=http://localhost:3000 npm run dev
```

- `AUTH_SECRET` signs the staff sessions; `NEXTAUTH_URL` is the origin sign-in
  redirects to, and the base the in-process scheduler calls.
- With `CRON_SECRET` set, the in-process scheduler (`instrumentation.ts`) also
  runs in `npm run dev`: it calls the telematics poll every 15 minutes at
  `NEXTAUTH_URL` (default port 3300 when unset, so set it to the dev port). A
  poll can therefore land between your steps; it is idempotent, but counts in
  the poll's answer may include its work.

- `npm run dev` is not a deployed build, so the simulator is allowed.
- A production build needs `SIMULATED_INTEGRATIONS=simulated-telematics`. Set
  it on demo stacks only, never for a real lender.
- To test the dealer refusal, also set `DEALER_APP_HOST` and
  `TENANT_HOST_MAP` (see `lib/dealer/.claude.md`).

Drive the poll the way production does:

```bash
curl -H "x-cron-secret: $CRON_SECRET" http://localhost:3000/api/cron/asset-finance-telematics-poll
```

## What to capture (screenshots in this folder)

1. Asset page, Tracker devices card: the heartbeat and the amber "Simulated"
   chip.
2. Deal page of `beforePayout.dealId`, Payout panel: the heartbeat beside
   "Tracker fitted and confirmed", reading "evidence still required: tracker
   certificate", the item still open.
3. Loan page of the TAMPER lease, readings table:
   - the "Telematics, simulated" rows;
   - the projected excess (STEADY runs 6 h/day against an allowance of
     about 4.1 h/day).
4. Tracker alerts → Held readings: the ROLLBACK reading (day 15, 200 h lower).
   Reject it with a note.
5. Tracker alerts: the TAMPER work item in the Servicing queue (the lease is
   in good standing; Collections takes a loan in default). Also at 390 px
   wide: each item is a card with its actions on screen.
6. As COLLECTIONS_OFFICER on the TAMPER lease before any legal matter: the
   Recovery panel shows "Last known position: This loan is not in default."
   instead of the button. As CREDIT_OFFICER, open a legal matter. Then, as
   COLLECTIONS_OFFICER, press "Show last known position" in the Legal matter
   panel. Capture the coordinate text with its time.
7. As READONLY: the button is absent. A
   `POST /api/asset-finance/loans/<id>/telematics/position` returns 403.
8. As the dealer, on the dealer host: `/api/asset-finance/...` returns 404, and
   the dealer's view of `dealerDeal.dealId` shows no device, heartbeat,
   alert or position.
9. Zero page errors in the console throughout.

Tear down:

```bash
bash scripts/it-db.sh down <name>
```

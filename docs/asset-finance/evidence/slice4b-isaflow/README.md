# Slice 4b: IsaFlow draft push, browser acceptance

Run 2026-10-16 against `feat/af-isaflow-push` on a local `next dev`, a fresh
`prisma migrate reset` seed in a throwaway Postgres (`scripts/it-db.sh`) and
the fake IsaFlow (`npx tsx scripts/fake-isaflow.ts 4010`). Never a real
IsaFlow. Driven by headless Chromium (Playwright).

## Setup that is not in the product
- The seed has no SUPER_ADMIN, so the seed admin was promoted in the
  throwaway DB. It signed in with password plus a TOTP code, so the session is
  TOTP-verified.
- `ISAFLOW_ALLOWED_ORIGINS=http://127.0.0.1:4010` (loopback http is accepted
  only when listed and only under NODE_ENV test/development).
- All seeded activity falls in the current month (October 2026). To have an
  ended month with journals, the dev server ran with its JS clock shifted 17
  days forward (a `Date` preload), so October 2026 could close. September
  2026, the go-live month, closed empty first. Dates shown as "closed
  2026/11/02" come from that shift.

## Steps and what was seen
| # | Screenshot | What it shows |
|---|---|---|
| 1 | `01-isaflow-not-connected.png` | Settings → Integrations: IsaFlow card, NOT CONNECTED |
| 2 | `02-isaflow-connected.png` | After Connect with the fake PAT: CONNECTED, company "Fake IsaFlow Dev Co" (from `list_companies`); the token field is empty |
| 3 | `03-mapping-confirmed.png` | Go-live September 2026 saved, mapping saved and confirmed |
| 4 | `04-september-closed.png` | September closed with 0 entries |
| 5 | `05-october-preview.png` | October preview: 27 entries, R 5,039,948.48 each side, balanced |
| 6 | `06-october-closed-before-push.png` | October closed; IsaFlow "Not pushed" with a Push button |
| 7 | `07-pushed.png` | After Push: PUSHED, draft id shown |
| 8 | `08-pushed-light.png` | The same in light mode |
| 9 | `09-pushed-390px.png` | The same at 390 px |
| 10 | `10-connection-390px.png` | The connected card at 390 px |
| 11 | `11-connection-light.png` | The connected card in light mode |
| 12 | `12-history-isaflow-column.png` | After review fixes: Export history has an IsaFlow column (October PUSHED) |

- `GET /api/integrations/isaflow` after connect returned status, base URL,
  company id and name, and timestamps. No token field.
- The fake logged, for the push: one `list_gl_accounts` (chart check) and one
  `create_draft_journal -> created`.
- Re-push of the same batch through the API
  (`POST /api/accounting/batches/<id>/isaflow {"action":"push"}`) returned
  `409 {"error":"This batch is already in IsaFlow"}`, and the fake logged no
  further call. The UI hides the Push button once PUSHED.
- Pushing the empty September batch returned 422 (nothing to push).

## Not shown here
- Connect refused without TOTP, cross-tenant 404, stale SENDING, read-back and
  the deleted-draft case: covered by route tests and ITs (see `MUTATIONS.md`).
- The live push to a real IsaFlow dev company: blocked on Hein (goal §9).

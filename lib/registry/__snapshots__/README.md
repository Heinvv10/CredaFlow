# Registry parity snapshots

The exact runtime values of each registry on `origin/main` at `e343dc4f`,
taken before the lists were split into per-domain entry files.
`lib/registry/registries.test.ts` requires every entry here to still exist,
with the same value and in the same relative order.

These files are frozen. An entry added since does not belong here (adding it
would make every feature PR edit the same file again). A PR that deliberately
retires or changes one of these entries removes or changes it here, and says
why in its description.

## Deliberate changes

- `permissions.json`, client `decline_loan`: `CREDIT_OFFICER` → `LOAN_ADMIN`
  (2026-10-15, Hein). The server and client maps became one map with the
  server's values. No code called the client `canDo` with `decline_loan`, so
  no access changed; the server already required `LOAN_ADMIN`.

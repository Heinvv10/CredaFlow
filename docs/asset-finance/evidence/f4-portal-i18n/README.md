# F4: portal recovery card in another locale

Captured 2026-10-16 from `fix/af-slice4-followups` on a local dev server
(`next dev`, fresh `prisma migrate reset` seed, synthetic borrower
`test.director.one@acme-lending.invalid`, seed recovery at SHORTFALL_OPEN),
390 px viewport, `cf-locale` cookie set to `af` and `zu`.

- `portal-recovery-af.png`: Afrikaans
- `portal-recovery-zu.png`: isiZulu

What you see: the heading, the description line and "Notices issued" are
translated. Everything that mirrors the s127/s131 notices or states an amount
owed stays English, as `lib/i18n/.claude.md` requires (never translate
statutory or collections text): the notice names, the final-account figures,
"Shortfall you owe", the freeze-deadline line, the cost names and treatments,
and the SHORTFALL OPEN status.

After review round 1 every recovery status stays English, not only the notice,
shortfall and surplus ones: the statuses (Recovered, Valued, Listed for sale,
Sold, Proceeds applied, …) are together the legal state of the s127/s131
process. Only the heading, the description line, "Notices issued" and "None
yet" are translated. The screenshots above show a SHORTFALL_OPEN recovery, whose
status was English already, so they still match. The list is in the header of
`lib/i18n/messages/en/portal-recovery.ts`; `PortalRecoveryCard.i18n.test.tsx`
asserts it.

The rest of the portal page (navigation, schedule) is translated by the
existing W7 catalogue. The "N" bubble bottom-left is the Next.js dev indicator.

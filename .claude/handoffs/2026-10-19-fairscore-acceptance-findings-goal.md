# Goal — fix every open Fair Score acceptance finding (2026-10-19)

Hein: "I also want to fix all the issues." Source of truth for each finding (location, evidence,
severity): `.claude/handoffs/2026-10-19-fairscore-audit-ledger.md`, rows 111–120 (NEW) and the
GATED/DATA rows 100, 105, 108. Evidence page: https://claude.ai/artifact/H77u3PX1zXCXpvkK5ye7Zi
(private, v3; source `scratchpad/artifact/fair-score-audit-evidence.html` of session 57eb241d —
gone with that session, re-read the artifact with `Artifact action:read` to update it).

## State at handoff
- main includes #189 (PASQ p2 + mandate day, 2d0370ef) and #191 (S129 totals, 1773c901). mq empty.
- Live Fair Score runs `credaflow:fairscore-2d0370ef` (another agent upgraded + baked it 2026-10-19
  09:21). It lacks #191 and everything below. No staging copy, acceptance worktree or test image left.

## Work (one PR per row or tight group; `mq add <pr>` only; blind review on each)
| Row | Fix | Notes |
|---|---|---|
| 111 MEDIUM | Portal qualify page counts the client's own loans with the lender (instalments + arrears), same as the staff affordability path (B3) | Thabo Sithole, 60 DPD, shown R1,330 / "up to R100,000". Reuse the staff own-lender logic (#186), don't fork it |
| 118 LOW-MED | Afrikaans portal: translate the English strings (current-account panel, signing/OTP copy, apply declarations, product name) | Declaration and signing copy is consent text: NCA/legal wording, needs Hein sign-off |
| 112 | AF supplier-evidence link for an individual lessee uses entities/null → 404 | AF-MNFLXDJS-M5BH |
| 113 | Credit memo lists the deal's own booked loan as an existing exposure | AF-MNFLXCO4-KER0 |
| 114 | Payment plan: last instalment absorbs the rounding cent | 3 × R686.11 vs R2,058.34 |
| 115 | Collections stage hint names the S129 action while the button says unavailable (<90 DPD) | copy |
| 116 | Insurance catalogue card price vs rate-table price (R118 vs R171) | decide which is the "from" price |
| 117 | One currency format across the insurance screens | |
| 119 | Staff 404 page: no public "Apply online / Check if I qualify" links | |
| 120 | Sign page: say which declarations are unticked instead of doing nothing | |
| 100, 105, 108 | Blocked on Hein: real NCRCP, LLM key for the site chat, FNB/SB/Nedbank/Capitec CSV samples | Ask once, don't build around them |

## Rules that bite here
- NCA wording/numbers and consent copy: Hein signs off before merge. Re-pin PDF hashes only with a proof.
- Verify in a browser against a seeded local stack (real roles), not just tests.
- Update the ledger rows + the evidence artifact as each PR merges.
- Then, after 17:00 and with Hein's approval only: new Fair Score image + bake + switch (covers #191 too).
  Check the sim lock and other sessions first (another agent did today's deploy).

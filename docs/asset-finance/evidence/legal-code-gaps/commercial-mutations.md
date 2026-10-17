# Commercial guard mutation evidence

2026-10-17, isolated worktree, Node 22. Each mutation was restored immediately.

- wet-ink server refusal: rejected by tests (exit 1).
- commercial settlement rebate: rejected by tests (exit 1).
- common-law default-interest ceiling: rejected by tests (exit 1).
- CPA scope wording variant: rejected by tests (exit 1).
- surety physical-address row: rejected by tests (exit 1).

P1 scheduled-interest follow-up: replacing default activation with `false`
failed two regressions (20855 versus 20000 combined unpaid interest, and 20000
versus 10000 collectible contractual arrear interest). Mutation exit 1;
production source restored. Focused suite then passed before final CI.

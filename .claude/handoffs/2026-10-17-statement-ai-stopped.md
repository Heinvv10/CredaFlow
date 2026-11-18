# Statement AI goal: STOPPED at the review stop rule (2026-10-17 ~13:00 SAST)

Goal: `.claude/handoffs/2026-10-17-statement-ai-goal.md`. Worktree: `/home/hein/Workspace/CredaFlow-stmt-ai` (branch `feat/statement-ai-ask`).

## State

- PRs: #159 core (schema, switch, post-check), #161 A+B, #163 C (stacked). All pushed, **not queued**.
  - #163 head `54fabf22`.
  - #159 and #161 are **behind #163** by the last 4 post-check commits: `50ce6954` is ported, `6d106653`, `4eaec722` and `54fabf22` are not. Port them, or collapse the stack, before any merge.
- Nothing is merged and no demo stack was touched. The feature flag defaults to off.

## Why stopped

Goal §8.8 stop rule: rounds 2 and 3 together (~34 findings) exceeded round 1 (~23).

| Round | Breaker | Reviewer |
|---|---|---|
| 1 | 6 | 17 |
| 2 | 7 groups | ~9 |
| 3 | 12 (11 HIGH), against `2283f50b` | 6 (round 3) |

The round-4 reviewer stalled and never reported.

Each round closes its repros, and the next finds new phrasings. The open class is **meaning, not wording**: free prose checked by a deterministic filter.
- Figures are safe: every eval run shows 0 wrong numbers shown.
- What still leaks is semantic contradiction made of allowed words:
  - "the threshold of 5% is above the spend";
  - "only R500.00 went to betting";
  - "if spend is above 5%";
  - "R1 234.56 went out";
  - "credits totalled R500.00";
  - monthly or total roles ("for the period", "over the year").
- The officer's question can also unlock figures and relations.
- Full round-3 breaker report: the session transcript, agent `stmt-ai-breaker-r3`.

## Evidence so far

- **Real-PG suites.** All green on #163: settings, A+B, ask, worker, with READONLY and cross-tenant cases.
- **Mutation tests.** Round 1 M1–M13 and B1–B3; round 2 R2-1 to R2-17; round 3 R3-1 to R3-8.
  - Every guard goes red when removed, except the documented defense-in-depth cases R2-15 and A6.
  - Mutation logs are in this conversation's scratchpad, `mutations-round2.txt` and `mutations-round3.txt`.
- **Eval** at `413a03a9` (30 synthetic apps × 3 runs, ≥30 questions; the local Qwen3-VL-30B-A3B):

  | Feature | Result |
  |---|---|
  | C (questions) | 0 wrong figures shown; exact 90 / 86.7 / 95% (min **86.7%**, below the 95% target). Every miss was a false rejection; three causes are fixed in `54fabf22`, not re-measured. |
  | A (summary) | 53% rejected |
  | B (explanations) | 25–30% rejected |

  - Main A/B causes: payee/system-name stripping order, and "match tolerance". Both are fixed in `54fabf22`, not re-measured.
- **Latency and tokens per call** (pricing input):

  | Kind | Median latency | p95 latency | Tokens in | Tokens out |
  |---|---|---|---|---|
  | Summary | 4.9 s | 7.6 s | ~1 100 | ~300 |
  | Explanation | 1.6 s | 2.5 s | ~775 | ~99 |
  | Answer (×2 calls per question) | 0.55 s | 1.06 s | ~523 | ~31 |

  - One statement with 3 flags is about 1 summary plus 3 explanations: roughly 4 300 tokens in, 600 out, about 10 s of model time.
- **Browser check** (pre-round-1 code), LOAN_ADMIN and READONLY, dark and light, desktop and 375 px: screenshots in the scratchpad. Re-do it on the final design.
- Not done: `ci:quality` and `ci:integration` locally on the final head; tamper triage (§6) was never started.

## Decision for Hein (the next step depends on it)

1. **Recommended: structured outputs for A, B and C.**
   - The model returns typed claims, e.g. `{claim: "payee_total", payee, ref}` or `{claim: "flag_rule", code}`. Code renders each sentence from a fixed template.
   - The model chooses and orders the content; every sentence's meaning is code-owned.
   - The post-check shrinks to validating the claim JSON. C already works this way for its queries; only its final prose is free.
   - Cost: about a day. Prose becomes plainer.
2. **Ship as-is behind the flag (off) as accepted risk.** The figure guarantee holds; semantic contradiction remains possible. It needs Hein's explicit acceptance and a PR comment listing the open repros.
3. **Keep hardening the free-prose filter.** Not recommended: the death-spiral signal.

Infrastructure note: an IsaFlow OCR bench session stops `vllm-qwen` during its GPU windows (`~/isaflow-ocr-bench/scripts/window.sh`). Check `:8100` before any eval.

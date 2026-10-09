#!/usr/bin/env tsx
/**
 * Mirror the Claude-facing docs into Codex-facing `AGENTS.md` siblings.
 *
 * Claude Code reads `CLAUDE.md` + nested `.claude.md`. OpenAI Codex (and Devin,
 * and Copilot as a fallback) read `AGENTS.md`, walking the tree the same way.
 * Rather than maintain two sets of rules that will disagree within a week,
 * `CLAUDE.md` stays canonical and this renders the `AGENTS.md` view of it.
 *
 * The only transform is the filename one: a doc telling Codex to read
 * `lib/pdf/.claude.md` is telling it to read a file it will never look at, so
 * those references are rewritten to the sibling it does read.
 *
 * Usage:
 *   npm run agents:mirror          # write
 *   npm run agents:mirror -- --dry-run
 *   npm run agents:check           # exit 1 if any mirror is stale OR MISSING
 *
 * `--check` compares rendered content to disk rather than using `git diff`:
 * git cannot see an untracked file, so a diff-based gate passes silently when a
 * sibling that SHOULD exist was never committed at all.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** Codex stops reading at 32 KB; warn well before we get there. */
const CODEX_LIMIT_BYTES = 32 * 1024;
const WARN_BYTES = 28 * 1024;

/** N-rule: don't port a stub, or a doc for a module too small to need one. */
const MIN_SOURCE_FILES = 4;
const MIN_DOC_LINES = 10;

const SCAN_ROOTS = ["lib", "app", "prisma"];

function listClaudeMd(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) listClaudeMd(full, acc);
    else if (entry.name === ".claude.md") acc.push(full);
  }
  return acc;
}

/**
 * Deliberately non-recursive: a module doc describes the code beside it. A
 * module organised mostly through subdirectories could therefore read as
 * "small" and be skipped — revisit the heuristic if that shape appears rather
 * than recursing blindly into fixtures and generated output.
 */
function countSourceFiles(dir: string): number {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) n++;
  }
  return n;
}

function banner(canonical: string): string {
  return [
    `<!-- GENERATED — do not edit. Canonical source: ${canonical} -->`,
    `<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->`,
    `<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose`,
    `     below may refer to ".claude.md" when describing the canonical side;`,
    `     that is accurate — only PATH references are rewritten to AGENTS.md. -->`,
    ``,
  ].join("\n");
}

/**
 * Rewrite only backtick-quoted PATH references, e.g. `lib/pdf/.claude.md` ->
 * `lib/pdf/AGENTS.md`, because that names a file Codex would never open.
 *
 * The `/` in the pattern is load-bearing. A blanket `.claude.md` -> `AGENTS.md`
 * also rewrites prose ABOUT the mirroring system, which produced genuinely
 * false output in the first cut of this script: "the only transform is
 * `AGENTS.md` -> `AGENTS.md`" (a tautology that ate its own subject), and a
 * sentence claiming the path gate scans nested `AGENTS.md` when it scans
 * `.claude.md`. Shipping false claims into the file Codex reads is the exact
 * failure this whole mechanism exists to prevent, so keep the rewrite narrow:
 * a path has a directory in front of it, a concept does not.
 */
function render(source: string, canonical: string): string {
  const body = readFileSync(source, "utf8")
    .replace(/`([^`\s]*\/)\.claude\.md`/g, "`$1AGENTS.md`");
  return banner(canonical) + body;
}

type Target = { out: string; source: string; canonical: string };

function targets(): { emit: Target[]; skipped: string[] } {
  const emit: Target[] = [];
  const skipped: string[] = [];

  emit.push({
    out: resolve(ROOT, "AGENTS.md"),
    source: resolve(ROOT, "CLAUDE.md"),
    canonical: "CLAUDE.md",
  });

  const nested: string[] = [];
  for (const r of SCAN_ROOTS) listClaudeMd(resolve(ROOT, r), nested);

  for (const doc of nested) {
    const dir = dirname(doc);
    const rel = relative(ROOT, doc);
    const files = countSourceFiles(dir);
    const lines = readFileSync(doc, "utf8").split("\n").length;
    if (files < MIN_SOURCE_FILES) {
      skipped.push(`${rel} — small-module (${files} source files)`);
      continue;
    }
    if (lines < MIN_DOC_LINES) {
      skipped.push(`${rel} — stub (${lines} lines)`);
      continue;
    }
    emit.push({ out: resolve(dir, "AGENTS.md"), source: doc, canonical: "./.claude.md" });
  }
  return { emit, skipped };
}

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const DRY = argv.includes("--dry-run");

const { emit, skipped } = targets();
const stale: string[] = [];
const missing: string[] = [];
const written: string[] = [];

for (const t of emit) {
  const content = render(t.source, t.canonical);
  const rel = relative(ROOT, t.out);
  const bytes = Buffer.byteLength(content, "utf8");

  if (bytes > CODEX_LIMIT_BYTES) {
    console.error(`[agents] FAIL — ${rel} is ${(bytes / 1024).toFixed(1)} KB, over Codex's 32 KB cut-off.`);
    process.exit(1);
  }
  if (bytes > WARN_BYTES) {
    console.warn(`[agents] warn — ${rel} is ${(bytes / 1024).toFixed(1)} KB, approaching the 32 KB cut-off.`);
  }

  if (CHECK) {
    if (!existsSync(t.out)) missing.push(rel);
    else if (readFileSync(t.out, "utf8") !== content) stale.push(rel);
    continue;
  }
  // Only touch a file whose content actually changed, so `--dry-run` is a
  // truthful preview of the real run and the printed count means something.
  // Unconditional writes made every run report "wrote 5 files", which would
  // hide an unexpected mass-regeneration in the noise of always saying 5.
  const unchanged = existsSync(t.out) && readFileSync(t.out, "utf8") === content;
  if (unchanged) continue;
  if (!DRY) writeFileSync(t.out, content, "utf8");
  written.push(rel);
}

if (CHECK) {
  if (missing.length === 0 && stale.length === 0) {
    console.log(`[agents:check] OK — ${emit.length} AGENTS.md mirror(s) match their canonical source.`);
    process.exit(0);
  }
  console.error(`[agents:check] FAIL — AGENTS.md is out of sync with CLAUDE.md:\n`);
  for (const m of missing) console.error(`  MISSING  ${m}`);
  for (const s of stale) console.error(`  STALE    ${s}`);
  console.error(`\nFix: npm run agents:mirror`);
  process.exit(1);
}

console.log(
  DRY
    ? `[agents] dry-run — ${written.length} file(s) would be written.`
    : `[agents] wrote ${written.length} file(s).`,
);
for (const w of written) console.log(`  ${w}`);
for (const s of skipped) console.log(`  [skip] ${s}`);

#!/usr/bin/env tsx
/**
 * Drift gate for the agent-facing docs in this repo.
 *
 * Fails if any backtick-quoted `lib/...` / `app/...` path doesn't exist on
 * disk. Catches the "rename without doc update" pattern that no test notices.
 *
 * Covers THREE tiers — the root CLAUDE.md and the skills were unprotected
 * until 2026-07-29, which is exactly where the drift accumulated (the root file
 * carries the most path references of any doc in the repo):
 *   1. nested `.claude.md` under lib/ app/ prisma/
 *   2. root `CLAUDE.md`
 *   3. `.claude/skills/ **&#47; *.md`
 *
 * Usage:  npm run claude-md:check
 * Exits 0 if clean, 1 if any stale path is found.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SCAN_ROOTS = ["lib", "app", "prisma"]
  .map((d) => resolve(ROOT, d))
  .filter((p) => existsSync(p));

function listClaudeMd(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      listClaudeMd(full, acc);
    } else if (entry.name === ".claude.md") {
      acc.push(full);
    }
  }
  return acc;
}

const PATH_RE = /`((?:lib|app|prisma|components|public)\/[^`\s]+)`/g;
const TS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".prisma"];

/**
 * A trailing directory glob still names a real directory: `app/api/cron/*`
 * means "that directory exists and has things in it", so strip the glob and
 * check the directory. Dropping this check was a silent regression — the
 * string appears three times in the docs today.
 */
function stripTrailingGlob(candidate: string): string {
  return candidate.replace(/\/\*+$/, "").replace(/\*+$/, "");
}

/**
 * What genuinely cannot be checked: an extension glob (`lib/pdf/*.ts` — no
 * single file to resolve), a placeholder (`.../<slug>.mp4`), an elision
 * (`lib/...`). Asserting those exist would only teach people to route around
 * the gate. Applied AFTER stripping a trailing glob, so `dir/*` is still
 * verified rather than waved through.
 */
function isUncheckablePattern(candidate: string): boolean {
  return /[*<>]/.test(candidate) || candidate.includes("...");
}

type Hit = { doc: string; path: string };

function pathExists(candidate: string): boolean {
  const abs = resolve(ROOT, candidate);
  if (existsSync(abs)) return true;
  for (const ext of TS_EXTS) {
    if (existsSync(abs + ext)) return true;
  }
  for (const ext of TS_EXTS) {
    if (existsSync(resolve(abs, "index" + ext))) return true;
  }
  return false;
}

/** Every `.md` under .claude/skills — SKILL.md and its references/. */
function listSkillDocs(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) listSkillDocs(full, acc);
    else if (entry.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

function findStalePaths(): Hit[] {
  const hits: Hit[] = [];
  const docs: string[] = [];
  for (const root of SCAN_ROOTS) {
    listClaudeMd(root, docs);
  }
  const rootDoc = resolve(ROOT, "CLAUDE.md");
  if (existsSync(rootDoc)) docs.push(rootDoc);
  listSkillDocs(resolve(ROOT, ".claude/skills"), docs);
  for (const doc of docs) {
    const relDoc = doc.slice(ROOT.length + 1);
    const content = readFileSync(doc, "utf8");
    for (const match of content.matchAll(PATH_RE)) {
      const claimed = match[1];
      const candidate = stripTrailingGlob(claimed);
      if (isUncheckablePattern(candidate)) continue;
      if (!pathExists(candidate)) {
        hits.push({ doc: relDoc, path: claimed });
      }
    }
  }
  return hits;
}

const hits = findStalePaths();

if (hits.length === 0) {
  console.log(`[claude-md:check] OK — all path references in CLAUDE.md, nested .claude.md, and .claude/skills exist.`);
  process.exit(0);
}

console.error(`[claude-md:check] FAIL — ${hits.length} stale path reference(s):\n`);
for (const { doc, path } of hits) {
  console.error(`  ${doc}\n    → ${path}\n`);
}
console.error(`Fix: update the nested doc, or run /kb to regenerate it.`);
process.exit(1);

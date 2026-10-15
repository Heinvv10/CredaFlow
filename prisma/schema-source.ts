import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

/** The schema folder (prismaSchemaFolder): one `.prisma` file per domain. */
export const PRISMA_SCHEMA_DIR = join(__dirname, "schema")

/** Every schema file's text, in path order, joined — what one schema.prisma used to hold. */
export function readPrismaSchema(): string {
  return readdirSync(PRISMA_SCHEMA_DIR)
    .filter((f) => f.endsWith(".prisma"))
    .sort()
    .map((f) => readFileSync(join(PRISMA_SCHEMA_DIR, f), "utf8"))
    .join("\n")
}

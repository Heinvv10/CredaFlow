/**
 * Helpers for the dealer draft purge suites and browser seed
 * (RUN_ASSET_FINANCE_DEALER_IT): a dealer-uploaded document with real bytes in
 * managed storage, and moving a deal's activity dates into the past (triggers
 * off, as history). Every value is synthetic. Not a test file.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { lit, newId, type DealerFixture } from "./dealer.integration-fixture"

const UPLOADS = path.join(process.cwd(), "uploads")

/** A document of the deal, uploaded by its dealer, with real bytes in managed storage. */
export function storedDocument(fx: Pick<DealerFixture, "tenantId" | "salesUserA">, dealId: string, docType = "POPIA_CONSENT"): { id: string; file: string } {
  const id = newId("doc")
  const file = path.join(UPLOADS, `${randomUUID()}.pdf`)
  mkdirSync(UPLOADS, { recursive: true })
  writeFileSync(file, "%PDF-1.4\n% synthetic purge test")
  sql(`INSERT INTO "EntityDocument" ("id", "tenantId", "entityId", "dealId", "docType", "fileName", "mimeType", "fileSize", "storagePath",
      "contentSha256", "uploadedByType", "uploadedById")
    SELECT ${lit(id)}, ${lit(fx.tenantId)}, d."entityId", d."id", '${docType}', 'TEST person ID.pdf', 'application/pdf', 1,
      ${lit(file)}, repeat('0', 64), 'dealer', ${lit(fx.salesUserA)}
    FROM "AssetFinanceDeal" d WHERE d."id" = ${lit(dealId)}`)
  return { id, file }
}

/** Move every activity date of the deal (its documents, attestations, requests, people, business and asset) `days` into the past. */
export function age(dealId: string, days: number): void {
  const back = (column: string) => `"${column}" = "${column}" - INTERVAL '${days} days'`
  sql(`BEGIN; SET LOCAL session_replication_role = replica;
    UPDATE "AssetFinanceDeal" SET ${["createdAt", "updatedAt", "cancelledAt", "decidedAt", "dealerSubmittedAt"].map(back).join(", ")}
      WHERE "id" = ${lit(dealId)};
    UPDATE "EntityDocument" SET ${back("createdAt")} WHERE "dealId" = ${lit(dealId)};
    UPDATE "DealerConsentAttestation" SET ${back("attestedAt")} WHERE "dealId" = ${lit(dealId)};
    UPDATE "DealerDocumentRequest" SET ${back("requestedAt")}, ${back("fulfilledAt")} WHERE "dealId" = ${lit(dealId)};
    UPDATE "EntityRelationship" r SET "createdAt" = r."createdAt" - INTERVAL '${days} days', "updatedAt" = r."updatedAt" - INTERVAL '${days} days'
      FROM "AssetFinanceDeal" d WHERE d."id" = ${lit(dealId)} AND r."entityId" = d."entityId";
    UPDATE "Client" c SET ${back("updatedAt")} WHERE c."id" IN (SELECT * FROM "dealerDealPeople"(
      (SELECT "tenantId" FROM "AssetFinanceDeal" WHERE "id" = ${lit(dealId)}), ${lit(dealId)}));
    UPDATE "BusinessEntity" e SET "updatedAt" = e."updatedAt" - INTERVAL '${days} days' FROM "AssetFinanceDeal" d WHERE d."id" = ${lit(dealId)} AND e."id" = d."entityId";
    UPDATE "FinancedAsset" f SET "updatedAt" = f."updatedAt" - INTERVAL '${days} days' FROM "AssetFinanceDeal" d WHERE d."id" = ${lit(dealId)} AND f."id" = d."assetId";
    COMMIT;`)
}

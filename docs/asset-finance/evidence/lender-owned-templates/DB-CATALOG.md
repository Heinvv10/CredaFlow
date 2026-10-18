# Live enforcement catalog (fresh migrated PG16, migrations through 20261018140100)

Queried with the CLAUDE.md catalog queries, filtered to the tables this work touches.

```
AssetDocumentIssuance | AssetDocumentIssuance_guard
DealSigner | DealSigner_guard
DealSigner | DealSigner_issuance
DealSigner | DealSigner_surety_wet_ink
DocumentTemplate | DocumentTemplate_asset_guard
DocumentTemplateVersion | DocumentTemplateVersion_asset_guard

"AssetDocumentIssuance" | AssetDocumentIssuance_shape
"DealSigner" | DealSigner_document_bound
"DealSigner" | DealSigner_method_evidence
"DealSigner" | DealSigner_role_document
"DealSigner" | DealSigner_wet_ink_four_eyes
"DocumentTemplate" | DocumentTemplate_asset_finance_shape
"DocumentTemplateVersion" | DocumentTemplateVersion_approval_shape

AssetDocumentIssuance_tenantId_id_key | CREATE UNIQUE INDEX "AssetDocumentIssuance_tenantId_id_key" ON public."AssetDocumentIssuance" USING btree ("tenantId", id)
DocumentTemplate_tenantId_id_key | CREATE UNIQUE INDEX "DocumentTemplate_tenantId_id_key" ON public."DocumentTemplate" USING btree ("tenantId", id)
DocumentTemplateVersion_one_active | CREATE UNIQUE INDEX "DocumentTemplateVersion_one_active" ON public."DocumentTemplateVersion" USING btree ("templateId") WHERE (status = 'ACTIVE'::"DocumentTemplateVersionStatus")
```

-- A separately added cost must carry evidence that it is not already deducted
-- from the goods valuation. Preserve the approved PV - net goods + costs rule.
CREATE FUNCTION public."leaseCostsExcludeValuationOverlap"(costs jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT jsonb_typeof(costs) = 'array' AND COALESCE(bool_and(
   COALESCE(jsonb_typeof(cost -> 'valuationNoOverlapEvidence') = 'string'
   AND length(btrim(cost ->> 'valuationNoOverlapEvidence')) > 0, false)
 ), true) FROM jsonb_array_elements(costs) AS cost;
$$;
ALTER TABLE "LeaseTerminationQuote" ADD CONSTRAINT "LeaseTerminationQuote_cost_overlap_evidence"
-- Historical immutable assessments retain their original evidence. PostgreSQL
-- still enforces NOT VALID CHECKs for every new or updated row.
CHECK (public."leaseCostsExcludeValuationOverlap"("documentedCosts")) NOT VALID;

import { Prisma } from "@prisma/client"

type CalendarQueryClient = {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>
}

export async function quotationValidUntilDateFromDatabase(
  db: CalendarQueryClient,
  presentedAt: Date,
  businessDays = 5,
): Promise<string> {
  if (
    !Number.isFinite(presentedAt.getTime())
    || !Number.isSafeInteger(businessDays)
    || businessDays < 0
  ) {
    throw new RangeError("Invalid quotation calendar input")
  }
  const rows = await db.$queryRaw<Array<{ validUntilDate: string }>>(Prisma.sql`
    SELECT TO_CHAR(
      "quoteValidUntilDate"(
        ${presentedAt}::TIMESTAMPTZ,
        ${businessDays}::INTEGER
      ),
      'YYYY-MM-DD'
    ) AS "validUntilDate"
  `)
  const validUntilDate = rows[0]?.validUntilDate
  if (
    typeof validUntilDate !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(validUntilDate)
  ) {
    throw new Error("The South African business calendar returned no valid date")
  }
  return validUntilDate
}

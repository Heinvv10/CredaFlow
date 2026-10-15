import { listOf, schemas } from "@/lib/lender-api/openapi-schemas"
import { API_SCOPE_LABELS, type ApiScope } from "@/lib/lender-api/scopes"
import { WEBHOOK_EVENTS } from "@/lib/lender-api/webhooks/events"
import { MAX_PAGE_SIZE } from "@/lib/lender-api/pagination"

/**
 * The OpenAPI 3.1 document served at /api/v1/openapi.json. Hand-written;
 * lib/lender-api/openapi.test.ts fails when a route under app/api/v1 (or one
 * of its methods, or the scope it checks) is missing here, or the reverse.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: unknown) => ({ "application/json": { schema } })
const error = (description: string) => ({ description, content: json(ref("Error")) })
const idParam = (what: string) => ({ name: "id", in: "path", required: true, schema: { type: "string" }, description: `The ${what} id.` })
const query = (name: string, description: string, schema: unknown = { type: "string" }) => ({ name, in: "query", required: false, schema, description })
const pageParams = [
  query("limit", `Page size, 1-${MAX_PAGE_SIZE} (default 50).`, { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE }),
  query("cursor", "The nextCursor of the previous page."),
]
const common = {
  "401": error("No API key, or the key is invalid, revoked or expired."),
  "403": error("The key lacks the scope, or the lender is not active."),
  "429": error("Rate limited (per key and per caller address). See Retry-After."),
}

function op(scope: ApiScope, summary: string, ok: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    summary,
    security: [{ apiKey: [scope] }],
    "x-required-scope": scope,
    ...extra,
    responses: { ...ok, ...common },
  }
}

export function buildOpenApiDocument(serverUrl?: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "CredaFlow lender API",
      version: "1.0.0",
      description: [
        "Read access to a lender's clients, applications, loans, schedules and payments, and creation of draft applications.",
        "Authenticate with `Authorization: Bearer <API key>`. A key belongs to one lender: it only ever sees that lender's records, whatever host or header is sent.",
        "Money is integer cents (ZAR); times are ISO 8601 UTC. Lists are newest first with cursor pagination.",
        "Recording payments is not offered: money writes are a separate design.",
        "Webhooks are signed: `CredaFlow-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of \"<t>.<raw body>\" keyed by the endpoint secret>`. Reject a timestamp more than 5 minutes off, compare in constant time, and dedupe on the event id.",
      ].join("\n\n"),
    },
    ...(serverUrl ? { servers: [{ url: serverUrl }] } : {}),
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: `Scopes: ${Object.entries(API_SCOPE_LABELS).map(([s, l]) => `\`${s}\` ${l}`).join("; ")}.`,
        },
      },
      schemas,
    },
    paths: {
      "/api/v1/clients": {
        get: op("clients:read", "List clients", { "200": { description: "A page of clients.", content: json(listOf("Client")) } }, { parameters: pageParams }),
      },
      "/api/v1/clients/{id}": {
        get: op("clients:read", "Get a client", { "200": { description: "The client.", content: json(ref("Client")) }, "404": error("No such client.") }, { parameters: [idParam("client")] }),
      },
      "/api/v1/applications": {
        get: op("applications:read", "List applications", { "200": { description: "A page of applications.", content: json(listOf("Application")) } }, {
          parameters: [...pageParams, query("status", "Filter by status."), query("clientId", "Filter by client.")],
        }),
        post: op("applications:write", "Create a draft application", {
          "201": { description: "The draft application. Staff complete and submit it in CredaFlow.", content: json(ref("Application")) },
          "400": error("The body is invalid."),
          "404": error("No such client or product."),
          "409": error("An application for this client and product is already open (details.existingApplicationId)."),
          "413": error("The body is larger than 16 KB."),
          "422": error("Refused: the client is blacklisted, deceased or has a defaulted loan, or the instalment fails affordability."),
        }, { requestBody: { required: true, content: json(ref("CreateApplication")) } }),
      },
      "/api/v1/applications/{id}": {
        get: op("applications:read", "Get an application", { "200": { description: "The application.", content: json(ref("Application")) }, "404": error("No such application.") }, { parameters: [idParam("application")] }),
      },
      "/api/v1/loans": {
        get: op("loans:read", "List loans", { "200": { description: "A page of loans.", content: json(listOf("Loan")) } }, {
          parameters: [...pageParams, query("status", "Filter by status."), query("clientId", "Filter by client.")],
        }),
      },
      "/api/v1/loans/{id}": {
        get: op("loans:read", "Get a loan", { "200": { description: "The loan.", content: json(ref("Loan")) }, "404": error("No such loan.") }, { parameters: [idParam("loan")] }),
      },
      "/api/v1/loans/{id}/schedule": {
        get: op("loans:read", "Get a loan's repayment schedule", {
          "200": {
            description: "The schedule, by instalment number.",
            content: json({ type: "object", properties: { loanId: { type: "string" }, data: { type: "array", items: ref("ScheduleItem") } }, required: ["loanId", "data"] }),
          },
          "404": error("No such loan."),
        }, { parameters: [idParam("loan")] }),
      },
      "/api/v1/payments": {
        get: op("payments:read", "List payments", { "200": { description: "A page of payments.", content: json(listOf("Payment")) } }, {
          parameters: [...pageParams, query("loanId", "Filter by loan.")],
        }),
      },
      "/api/v1/payments/{id}": {
        get: op("payments:read", "Get a payment", { "200": { description: "The payment.", content: json(ref("Payment")) }, "404": error("No such payment.") }, { parameters: [idParam("payment")] }),
      },
      "/api/v1/openapi.json": {
        get: { summary: "This document", security: [], responses: { "200": { description: "The OpenAPI document." } } },
      },
    },
    webhooks: Object.fromEntries(WEBHOOK_EVENTS.map((type) => [type, {
      post: {
        summary: `${type} event`,
        parameters: [
          { name: "CredaFlow-Signature", in: "header", required: true, schema: { type: "string" } },
          { name: "CredaFlow-Event-Id", in: "header", required: true, schema: { type: "string" } },
          { name: "CredaFlow-Event-Type", in: "header", required: true, schema: { type: "string" } },
          { name: "CredaFlow-Delivery-Id", in: "header", required: true, schema: { type: "string" } },
        ],
        requestBody: { content: json(ref("WebhookEvent")) },
        responses: { "2XX": { description: "Received. Anything else is retried with backoff for about 45 hours." } },
      },
    }])),
  }
}

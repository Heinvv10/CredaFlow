# Authenticated App Shell

These components define the authenticated UI system (light and dark) for the staff workspace and client portal.

Use this folder for staff app and client portal layout primitives. Do not use photographic backgrounds in authenticated app screens. Website imagery belongs under the public website implementation.

## Rules

- Use semantic CSS variables from `app/globals.css`.
- Use `PageHeader` at the top of migrated pages.
- Use `MetricCard` for KPI values.
- Use `DataPanel` for framed operational sections.
- Use `Badge` tone variants for statuses.
- Do not hard-code brand, dark, success, warning, danger, or info colors in migrated pages; the brand comes from the tenant (`--cf-brand*`).
- Keep staff screens dense and executive.
- Keep portal screens simpler and reassuring.

## Migration Order

1. Dashboard
2. Applications
3. Clients
4. Collections
5. Compliance
6. Reports
7. Portal dashboard
8. Portal documents and payments

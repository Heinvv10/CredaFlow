# Registry parity snapshots

The exact runtime values of each registry on `origin/main` at `e343dc4f`,
taken before the lists were split into per-domain entry files
(`lib/registry/registries.test.ts` compares the generated registries with them,
order included).

A merged PR that adds an entry adds it here too, in the same position the
generator produces. Never change a value to make the test pass without tracing
the entry to the PR that added it.

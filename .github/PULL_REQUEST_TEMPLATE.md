## Summary

<!-- Briefly describe what this PR changes and why. -->

Closes #

## Change Scope

- [ ] Dataform SQLX definitions (`definitions/`)
- [ ] Operations Dashboard bundle (`dashboards/operations/`)
- [ ] Malloy semantic models (`models/malloy/`)
- [ ] Documentation / Runbooks (`docs/`)
- [ ] CI / GitHub Workflows (`.github/`)

## Verification

- [ ] `npx --yes --package @dataform/cli@3.1.6 -- dataform compile --json > compiled.json && node scripts/check-graph.cjs compiled.json`
- [ ] `node dashboards/operations/build.cjs` leaves `dashboards/operations/index.html` up to date
- [ ] Reviewed downstream impact on warehouse tables, assertions, and dashboards

## Rollback Plan

<!-- Note any schema migrations or revert steps if this change needs to be rolled back. -->
Standard `git revert` on `main`.

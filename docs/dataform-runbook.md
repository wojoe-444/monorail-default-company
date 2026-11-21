# Dataform runbook

## Follow a refresh

| Pipeline tag | What it builds | Primary inputs |
| --- | --- | --- |
| `workforce_daily` | Department staffing and time-entry costs | `org`, `service_ops.time_entries` |
| `operations_daily` | Route reliability, incident summary, and maintenance backlog | `service_ops`, route ownership, CTA route names, workforce hours |
| `finance_monthly` | Department costs, budget variance, and supplier spend | `finance`, departments, workforce costs |
| `executive_scorecard` | Department scorecard, route cost allocation, and quality results | Staff, operations, finance, and company source records |

The 11 company reporting tables use the SELECT statements from the four existing BigQuery refresh procedures. Their Dataform dependencies are declared in SQLX. The original procedures still own the live warehouse refreshes and write their execution history to `demo_pipelines.run_log`.

CTA runs through `cta_staging` and `cta_analytics`. Its calendar view applies additions and removals before the route-day schedule is aggregated. The schedule assertion joins that independent result to company operations.

## Work in a development workspace

1. Compile at the repository root using Dataform CLI 3.1.6, or open a Dataform workspace connected to this repository.
2. Follow the model’s upstream `ref()` calls in the graph. Dataset-qualified refs are important when two relations share a name, such as the raw and staged bus route ridership tables.
3. Check the destination datasets. The defaults in [workflow settings](../workflow_settings.yaml) put output and assertion views in the `*_company_dev` datasets in US. The source declarations keep their original dataset names.
4. For an authorized development run, use a Dataform execution identity with source read access, BigQuery job access, and write access to the development datasets. Select the changed actions and include upstream dependencies on the first build. Google documents the Git connection, workspace configuration, and execution identity. [Dataform Git repository quickstart](https://docs.cloud.google.com/dataform/docs/quickstart-connect-git-repo)
5. Inspect assertion results before refreshing any dashboard that uses the changed metrics. The checked-in Malloy models point to the live sample datasets. A dashboard export from those models reflects the live warehouse state.

## Read a failed check

- **Enterprise integrity** checks the structural rules in `executive_reporting.demo_quality_checks`. Inspect the failed asset and its source key, relationship, or reconciliation rule.
- **Scheduled trip reconciliation** compares the planned count for each synthetic route-day with the loaded CTA GTFS schedule. Check the route ID, date, and GTFS feed coverage. The operations sample and schedule feed must cover the same service dates.
- **Pending invoice reconciliation** compares monthly pending dollars in the department and supplier views of the ledger. Check invoice status and department and supplier joins before changing the totals.

The quality mart also reports seeded business risks. The over-budget department and critical open repair remain visible in dashboards. The enterprise integrity assertion filters to structural checks. The CTA quality view preserves historical station-day source conflicts for investigation.

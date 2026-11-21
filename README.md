# MonoRail Transit Data Platform

Dataform workflows, operating docs, and dashboards for the fictional MonoRail Transit company. The BigQuery warehouse is `monorail-sample` in the US multi-region.

## Start here

| I need to… | Go to… |
| --- | --- |
| Review this shift’s service, staffing, fleet, and spend | [Operations dashboards](dashboards/) |
| Find the SQL or columns behind a warehouse relation | [Warehouse catalog](docs/warehouse-catalog.md) |
| Compile a change or trace a refresh failure | [Dataform runbook](docs/dataform-runbook.md) |
| Interpret operating numbers and reporting periods | [Operations handbook](docs/operations-handbook.md) |
| Inspect or reuse a semantic measure | [Malloy models](models/malloy/) |

## How the repository is laid out

- [`definitions/external_sources/`](definitions/external_sources/) declares the loaded BigQuery inputs by dataset. It includes the CTA imports, the synthetic company records, and the catalog and job-history tables.
- [`definitions/`](definitions/) contains CTA staging and analytics views, the four company reporting pipelines, and the quality assertions. The SQLX uses dataset-qualified `ref()` calls so the Dataform graph follows the same dependencies as the reporting SQL.
- [`models/malloy/`](models/malloy/) holds the semantic models used by MonoRail and the dashboard export. They read the existing warehouse.
- [`dashboards/`](dashboards/) holds the browser-ready operating workspace, the Malloy extract, and the source used to rebuild it.

## Compile locally

From the repository root with Node.js 22 or newer:

```sh
npx --yes --package @dataform/cli@3.1.6 -- dataform compile
```

Compilation requires no Google Cloud credentials. Managed outputs use datasets ending in `_company_dev`, and source declarations resolve to the existing warehouse datasets. The repository carries definitions and the dashboard's aggregate snapshot. The warehouse holds the underlying records.

Company personnel, finances, incidents, and delivered service are synthetic. CTA routes, schedules, and the historical ridership reference come from public sources. [CTA open data](https://www.transitchicago.com/data/)

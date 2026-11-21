# Warehouse catalog

Inventory of the 58 relations visible in `monorail-sample`. Declarations point to the loaded warehouse sources. Tables and views have executable SQLX and compile into datasets with the `_company_dev` suffix by default.

## cta

Imported CTA ridership and station data.

| Relation | Dataform action |
| --- | --- |
| [bus_route_ridership_daily](../definitions/external_sources/cta/bus_route_ridership_daily.sqlx) | declaration |
| [bus_route_ridership_monthly](../definitions/external_sources/cta/bus_route_ridership_monthly.sqlx) | declaration |
| [daily_boarding_totals](../definitions/external_sources/cta/daily_boarding_totals.sqlx) | declaration |
| [l_station_entries_daily](../definitions/external_sources/cta/l_station_entries_daily.sqlx) | declaration |
| [l_station_entries_monthly](../definitions/external_sources/cta/l_station_entries_monthly.sqlx) | declaration |
| [l_stops](../definitions/external_sources/cta/l_stops.sqlx) | declaration |

## cta_analytics

CTA ridership and schedule marts.

| Relation | Dataform action |
| --- | --- |
| [bus_route_ridership_monthly](../definitions/cta_analytics/bus_route_ridership_monthly.sqlx) | view |
| [rail_station_data_quality](../definitions/cta_analytics/rail_station_data_quality.sqlx) | view |
| [rail_station_ridership_monthly](../definitions/cta_analytics/rail_station_ridership_monthly.sqlx) | view |
| [ridership_monthly_by_mode](../definitions/cta_analytics/ridership_monthly_by_mode.sqlx) | view |
| [route_scheduled_service_daily](../definitions/cta_analytics/route_scheduled_service_daily.sqlx) | view |
| [sample_quality_checks](../definitions/cta_analytics/sample_quality_checks.sqlx) | view |
| [system_ridership_monthly](../definitions/cta_analytics/system_ridership_monthly.sqlx) | view |

## cta_gtfs

Imported CTA schedule feed.

| Relation | Dataform action |
| --- | --- |
| [agency](../definitions/external_sources/cta_gtfs/agency.sqlx) | declaration |
| [calendar](../definitions/external_sources/cta_gtfs/calendar.sqlx) | declaration |
| [calendar_dates](../definitions/external_sources/cta_gtfs/calendar_dates.sqlx) | declaration |
| [routes](../definitions/external_sources/cta_gtfs/routes.sqlx) | declaration |
| [shapes](../definitions/external_sources/cta_gtfs/shapes.sqlx) | declaration |
| [stop_times](../definitions/external_sources/cta_gtfs/stop_times.sqlx) | declaration |
| [stops](../definitions/external_sources/cta_gtfs/stops.sqlx) | declaration |
| [transfers](../definitions/external_sources/cta_gtfs/transfers.sqlx) | declaration |
| [trips](../definitions/external_sources/cta_gtfs/trips.sqlx) | declaration |

## cta_staging

CTA preparation and calendar expansion.

| Relation | Dataform action |
| --- | --- |
| [bus_route_ridership_daily](../definitions/cta_staging/bus_route_ridership_daily.sqlx) | view |
| [dim_rail_station](../definitions/cta_staging/dim_rail_station.sqlx) | view |
| [gtfs_service_dates](../definitions/cta_staging/gtfs_service_dates.sqlx) | view |
| [gtfs_trips](../definitions/cta_staging/gtfs_trips.sqlx) | view |
| [rail_station_ridership_daily](../definitions/cta_staging/rail_station_ridership_daily.sqlx) | view |

## demo_pipelines

Execution history for the warehouse refresh procedures.

| Relation | Dataform action |
| --- | --- |
| [run_log](../definitions/external_sources/demo_pipelines/run_log.sqlx) | declaration |

## executive_reporting

Executive oversight and data quality.

| Relation | Dataform action |
| --- | --- |
| [demo_quality_checks](../definitions/executive_reporting/demo_quality_checks.sqlx) | table |
| [department_scorecard](../definitions/executive_reporting/department_scorecard.sqlx) | table |
| [route_cost_efficiency](../definitions/executive_reporting/route_cost_efficiency.sqlx) | table |

## finance

Fictional budget and spend inputs.

| Relation | Dataform action |
| --- | --- |
| [expense_claims](../definitions/external_sources/finance/expense_claims.sqlx) | declaration |
| [monthly_budgets](../definitions/external_sources/finance/monthly_budgets.sqlx) | declaration |
| [supplier_invoices](../definitions/external_sources/finance/supplier_invoices.sqlx) | declaration |
| [suppliers](../definitions/external_sources/finance/suppliers.sqlx) | declaration |

## finance_reporting

Monthly budget and vendor marts.

| Relation | Dataform action |
| --- | --- |
| [budget_variance](../definitions/finance_reporting/budget_variance.sqlx) | table |
| [department_cost_monthly](../definitions/finance_reporting/department_cost_monthly.sqlx) | table |
| [vendor_spend_monthly](../definitions/finance_reporting/vendor_spend_monthly.sqlx) | table |

## METADATA

Catalog platform inputs.

| Relation | Dataform action |
| --- | --- |
| [entity](../definitions/external_sources/METADATA/entity.sqlx) | declaration |
| [entity_version](../definitions/external_sources/METADATA/entity_version.sqlx) | declaration |
| [lineage](../definitions/external_sources/METADATA/lineage.sqlx) | declaration |
| [meta](../definitions/external_sources/METADATA/meta.sqlx) | declaration |
| [record](../definitions/external_sources/METADATA/record.sqlx) | declaration |

## ops_reporting

Daily service and fleet marts.

| Relation | Dataform action |
| --- | --- |
| [incident_summary](../definitions/ops_reporting/incident_summary.sqlx) | table |
| [maintenance_backlog](../definitions/ops_reporting/maintenance_backlog.sqlx) | table |
| [route_performance_daily](../definitions/ops_reporting/route_performance_daily.sqlx) | table |

## org

Fictional organizational inputs.

| Relation | Dataform action |
| --- | --- |
| [cost_centers](../definitions/external_sources/org/cost_centers.sqlx) | declaration |
| [departments](../definitions/external_sources/org/departments.sqlx) | declaration |
| [job_roles](../definitions/external_sources/org/job_roles.sqlx) | declaration |
| [route_assignments](../definitions/external_sources/org/route_assignments.sqlx) | declaration |
| [staff](../definitions/external_sources/org/staff.sqlx) | declaration |

## org_reporting

Roster and time-entry marts.

| Relation | Dataform action |
| --- | --- |
| [department_staffing](../definitions/org_reporting/department_staffing.sqlx) | table |
| [staff_utilization_daily](../definitions/org_reporting/staff_utilization_daily.sqlx) | table |

## service_ops

Fictional operations inputs.

| Relation | Dataform action |
| --- | --- |
| [incidents](../definitions/external_sources/service_ops/incidents.sqlx) | declaration |
| [maintenance_work_orders](../definitions/external_sources/service_ops/maintenance_work_orders.sqlx) | declaration |
| [route_performance](../definitions/external_sources/service_ops/route_performance.sqlx) | declaration |
| [time_entries](../definitions/external_sources/service_ops/time_entries.sqlx) | declaration |
| [vehicles](../definitions/external_sources/service_ops/vehicles.sqlx) | declaration |

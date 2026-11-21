# Operations handbook

Open the [Shift Briefing](../dashboards/) before the service review. Use the work queues to follow up with the department leads listed in the briefing.

## Dispatch and fleet

- Rank cancellations using loaded route-days. Use the route chart to see when cancellations occurred and how many trips were completed on time.
- On-time rate is on-time trips divided by completed trips. Roll it up by summing both counts before dividing.
- Fleet counts include critical orders in the open-order total. The owner in the fleet queue owns the vehicle. The executive scorecard groups repairs by the department responsible for maintenance.
- The November service window covers November 2–15, 2026. The operations records reuse CTA route IDs and schedule counts. Delivered service and fleet outcomes are fictional. [CTA scheduled service data](https://www.transitchicago.com/developers/gtfs/)

Sources are [daily route performance](../definitions/ops_reporting/route_performance_daily.sqlx), [fleet backlog](../definitions/ops_reporting/maintenance_backlog.sqlx), and the [CTA schedule reference](../definitions/cta_analytics/route_scheduled_service_daily.sqlx).

## Workforce

- Active roster is the current headcount snapshot. Department managers come from the fictional staff directory.
- Scheduled, productive, absence, and overtime hours come from time entries. The sample covers ten business days from November 2–13, 2026.
- Labor cost uses the role rate and models overtime at 1.5 times that rate. Use the date and department filters to check whether an exception is concentrated in one shift.

Sources are [department staffing](../definitions/org_reporting/department_staffing.sqlx) and [daily utilization](../definitions/org_reporting/staff_utilization_daily.sqlx).

## Financial control

- Loaded actuals contain labor plus approved invoices and approved expenses. Pending invoices stay in the approval queue.
- Remaining budget is the full monthly allocation minus loaded actuals. November contains partial actuals. December has a budget and no loaded actuals.
- Modeled operating cost per trip uses assigned route labor plus approved non-labor spending allocated by the route’s share of completed trips in its department and month. Divide the summed cost by summed completed trips when comparing routes.

Sources are [budget variance](../definitions/finance_reporting/budget_variance.sqlx), [supplier spend](../definitions/finance_reporting/vendor_spend_monthly.sqlx), and [route cost efficiency](../definitions/executive_reporting/route_cost_efficiency.sqlx).

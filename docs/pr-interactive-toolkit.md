# Interactive PR Toolkit & Test-Drive Guide

This repository ships an interactive GitHub Pull Request toolkit that goes well beyond static lint comments — turning open PRs into a live warehouse control center with zero GCP credentials required.

## What's Installed

| Feature | Files | What it does |
| :--- | :--- | :--- |
| **PR Mission Control & Blast-Radius Radar** | [`.github/workflows/pr-lifecycle-card.yml`](../.github/workflows/pr-lifecycle-card.yml), [`scripts/pr-blast-radius.cjs`](../scripts/pr-blast-radius.cjs) | Compiles Dataform on `base` and `head`, renders a live color-coded **Mermaid lineage DAG** (`.sqlx` → downstream models → assertions → Malloy semantic sources), computes a **0–100 Blast-Radius Risk Score**, detects **Schema & Config Contract Diffs**, and embeds clickable Control Panel checkboxes. |
| **Interactive PR ChatOps & Checkbox Engine** | [`.github/workflows/pr-chatops.yml`](../.github/workflows/pr-chatops.yml) | Listens to PR `/slash` commands and checkbox clicks inside the Mission Control card, reacts live with 👀 → 🚀, runs actions safely on same-repo PRs, and logs every run in the card's Action Log. |
| **SQLFluff Report + One-Click `suggestion` Reviews** | [`.github/workflows/sqlx-lint.yml`](../.github/workflows/sqlx-lint.yml), [`scripts/lint-sqlx.py`](../scripts/lint-sqlx.py), [`scripts/post-pr-suggestions.cjs`](../scripts/post-pr-suggestions.cjs) | Formats the sticky SQLFluff comment with native GitHub Alerts (`[!TIP]`, `[!WARNING]`, `[!CAUTION]`) and a health score meter, auto-commits standard fixes, and generates exact diff-aligned GitHub ````suggestion```` review buttons for fixable advisory rules (`AM03`, `AM05`, `ST09`) or fork PRs. |

## Slash Commands (on any open PR)

- `/help` — Show the interactive command cheat sheet
- `/blast-radius` or `/lineage [model]` — Render a Mermaid lineage DAG for the PR's changed models (or any named model like `/lineage budget_variance`)
- `/compile <model>` — Compile Dataform and reply with the fully-resolved BigQuery SQL (`${ref(...)}` expanded) + column contract
- `/lint` or `/lint --fix` — Re-run SQLFluff on changed `.sqlx` files (and auto-commit fixes with `--fix`)
- `/suggest` — Post clickable inline ````suggestion```` review comments in *Files changed*
- `/rebuild-dashboard` — Rebuild `dashboards/operations/index.html` and commit it to the PR branch
- `/draft` · `/ready` · `/toggle-draft` — Toggle PR Draft / Ready for Review state via GitHub GraphQL

## Quick Test Drive

1. Merge these workflows onto `main` first (GitHub Actions only runs `issue_comment` workflows from the default branch!).
2. Open a test PR that makes a small edit to [`definitions/finance_reporting/budget_variance.sqlx`](../definitions/finance_reporting/budget_variance.sqlx) (for example, add a `JOIN` instead of `INNER JOIN`, lowercase `select`, or add a column to `config.columns`).
3. Watch the **🚝 MonoRail PR Mission Control** comment appear with a live Mermaid blast-radius graph showing downstream `executive_reporting.department_scorecard`, Malloy `financial_control` / `executive_departments`, and the schema diff.
4. Comment `/compile department_scorecard` to inspect the compiled BigQuery SQL right in the PR thread (watch the 👀 → 🚀 reaction!).
5. Comment `/suggest` (or tick **💡 Post Inline Advisory `suggestion` Comments** in the Mission Control card) and check **Files changed** for one-click **Commit suggestion** buttons!
6. Tick **🚦 Toggle Draft / Ready for Review** directly in the Mission Control comment and watch the PR flip state and log the action.

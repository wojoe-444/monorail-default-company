#!/usr/bin/env python3
"""SQLX linter and auto-fixer powered by SQLFluff.

Handles Dataform .sqlx files with ``templater = raw`` by separating top-level
Dataform blocks (``config``, ``js``, ``pre_operations``, ``post_operations``),
temporarily masking ``${...}`` template expressions with valid BigQuery
placeholders, running SQLFluff fix/lint passes according to ``.sqlfluff``, and
restoring the original Dataform syntax while mapping all diagnostics back to
exact 1-based ``.sqlx`` line numbers.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import sys
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from sqlfluff.core import FluffConfig, Linter

COMMENT_MARKER = "<!-- monorail-sqlfluff-lint -->"

DEFAULT_SUGGEST_ADVISORY_RULES = ["AM03", "AM05", "ST09"]

DEFAULT_ADVISORY_RULES = [
    "AL04",
    "AM01",
    "AM03",
    "AM04",
    "AM05",
    "AM06",
    "RF02",
    "RF04",
    "ST03",
    "ST05",
    "ST09",
    "ST11",
]

# Guidance shown in the PR comment for advisory warnings and unfixable checks.
RULE_GUIDANCE: dict[str, dict[str, str]] = {
    "AL04": {
        "name": "aliasing.unique.table",
        "why_manual": "Cannot infer intended distinct table aliases automatically.",
        "guidance": "Give each referenced table or CTE in the same clause a unique alias.",
    },
    "AM01": {
        "name": "ambiguous.distinct",
        "why_manual": "Removing DISTINCT or GROUP BY can change query semantics.",
        "guidance": "Avoid combining `SELECT DISTINCT` with `GROUP BY`; keep only the one that matches the intended grain.",
    },
    "AM03": {
        "name": "ambiguous.order_by",
        "why_manual": "Advisory-only rule; explicit sort direction is left to the author.",
        "guidance": "Specify `ASC` or `DESC` explicitly on every column in `ORDER BY`.",
    },
    "AM04": {
        "name": "ambiguous.column_count",
        "why_manual": "SQLFluff cannot resolve warehouse schemas to expand `SELECT *`.",
        "guidance": "List output columns explicitly instead of `SELECT *` so downstream schemas stay stable.",
    },
    "AM05": {
        "name": "ambiguous.join",
        "why_manual": "Advisory-only rule; kept manual so join intent is explicitly reviewed.",
        "guidance": "Write `INNER JOIN` (or `LEFT OUTER JOIN` / `CROSS JOIN`) explicitly instead of bare `JOIN`.",
    },
    "AM06": {
        "name": "ambiguous.column_references",
        "why_manual": "Switching between positional (`1, 2`) and named `GROUP BY`/`ORDER BY` is semantic.",
        "guidance": "Use either explicit column names or consistent positional references throughout `GROUP BY`/`ORDER BY`.",
    },
    "RF02": {
        "name": "references.qualification",
        "why_manual": "SQLFluff does not know which upstream table owns an unqualified column.",
        "guidance": "Prefix column references with their table/CTE alias (e.g. `t.column_name`) when multiple relations are in scope.",
    },
    "RF04": {
        "name": "references.keywords",
        "why_manual": "Renaming an identifier can break downstream BigQuery table schemas.",
        "guidance": "Avoid SQL keywords (e.g. `date`, `status`, `value`) as unquoted identifiers, or quote/rename them if safe.",
    },
    "ST03": {
        "name": "structure.unused_cte",
        "why_manual": "Deleting a CTE automatically may discard work-in-progress logic.",
        "guidance": "Remove the unused CTE or reference it in the downstream query.",
    },
    "ST05": {
        "name": "structure.subquery",
        "why_manual": "Advisory-only rule; refactoring inline subqueries into CTEs requires naming.",
        "guidance": "Move inline subqueries out of `FROM`/`JOIN` clauses into named CTEs in a `WITH` block.",
    },
    "ST09": {
        "name": "structure.join_condition_order",
        "why_manual": "Advisory-only rule; left-to-right join predicate ordering is reviewed manually.",
        "guidance": "Put the earlier-referenced table on the left side of `=` in `ON` join predicates.",
    },
    "ST11": {
        "name": "structure.unused_join",
        "why_manual": "Removing a join could drop an intentional filtering or fan-out effect.",
        "guidance": "Remove the unused join, or use `EXISTS` / `WHERE` if it is only acting as a filter.",
    },
    "PRS": {
        "name": "parser",
        "why_manual": "SQLFluff could not parse this SQL region.",
        "guidance": "Verify BigQuery SQL syntax and Dataform `${...}` expressions around this line.",
    },
}

DATAFORM_BLOCK_RE = re.compile(
    r"(?m)^[ \t]*(config|js|pre_operations|post_operations)[ \t]*\{"
)


@dataclass
class SqlxSegment:
    kind: str  # "raw" | "sql" | "operation_sql"
    text: str
    start_line: int  # 1-based line number in the .sqlx file
    block_name: str = ""  # "pre_operations" / "post_operations" for operation_sql
    indent_prefix: str = ""


@dataclass
class Finding:
    rule_code: str
    rule_name: str
    description: str
    line_no: int
    line_pos: int
    severity: str  # "standard_unfixable" | "advisory"
    section: str  # "query" | "pre_operations" | "post_operations"
    source_line: str = ""
    fixable_in_sqlfluff: bool = False


@dataclass
class FileLintResult:
    path: str
    status: str  # "clean" | "fixed" | "unfixable" | "skipped" | "error"
    skip_reason: str = ""
    changed: bool = False
    fixed_rule_counts: dict[str, int] = field(default_factory=dict)
    unfixable_standard: list[Finding] = field(default_factory=list)
    advisory_warnings: list[Finding] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def parse_advisory_rules_from_config(config_path: Path) -> list[str]:
    """Read the `# Advisory rules (...): ...` list from `.sqlfluff` if present."""
    if not config_path.exists():
        return list(DEFAULT_ADVISORY_RULES)
    text = config_path.read_text(encoding="utf-8")
    match = re.search(r"(?im)^#\s*Advisory rules[^:]*:\s*([A-Z0-9,\s]+)$", text)
    if not match:
        return list(DEFAULT_ADVISORY_RULES)
    rules = [r.strip().upper() for r in match.group(1).split(",") if r.strip()]
    return rules or list(DEFAULT_ADVISORY_RULES)


def _find_matching_brace(text: str, open_brace_idx: int) -> int:
    """Find the closing `}` matching `text[open_brace_idx] == '{'`.

    Respects JS single/double/template strings, escapes, `//` line comments,
    and `/* ... */` block comments.
    """
    n = len(text)
    depth = 0
    i = open_brace_idx
    in_string: str | None = None
    in_line_comment = False
    in_block_comment = False

    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""

        if in_line_comment:
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            if ch == "*" and nxt == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_string is not None:
            if ch == "\\":
                i += 2
                continue
            if ch == in_string:
                in_string = None
            i += 1
            continue

        if ch == "/" and nxt == "/":
            in_line_comment = True
            i += 2
            continue
        if ch == "/" and nxt == "*":
            in_block_comment = True
            i += 2
            continue
        if ch in ("'", '"', "`"):
            in_string = ch
            i += 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1

    return -1


def split_sqlx(content: str) -> list[SqlxSegment]:
    """Split a Dataform .sqlx file into ordered raw and SQL segments."""
    segments: list[SqlxSegment] = []
    n = len(content)
    pos = 0

    def line_at(offset: int) -> int:
        return content.count("\n", 0, offset) + 1

    while pos < n:
        match = DATAFORM_BLOCK_RE.search(content, pos)
        if not match:
            tail = content[pos:]
            if tail:
                segments.append(
                    SqlxSegment(
                        kind="sql" if tail.strip() else "raw",
                        text=tail,
                        start_line=line_at(pos),
                    )
                )
            break

        if match.start() > pos:
            between = content[pos : match.start()]
            segments.append(
                SqlxSegment(
                    kind="sql" if between.strip() else "raw",
                    text=between,
                    start_line=line_at(pos),
                )
            )

        block_name = match.group(1)
        open_brace = match.end() - 1
        close_brace = _find_matching_brace(content, open_brace)
        if close_brace == -1:
            # Unterminated block; keep raw so we never corrupt the file.
            rest = content[match.start() :]
            segments.append(
                SqlxSegment(kind="raw", text=rest, start_line=line_at(match.start()))
            )
            break

        if block_name in ("pre_operations", "post_operations"):
            header = content[match.start() : open_brace + 1]
            inner = content[open_brace + 1 : close_brace]
            footer = "}"
            segments.append(
                SqlxSegment(
                    kind="raw", text=header, start_line=line_at(match.start())
                )
            )
            if inner.strip():
                segments.append(
                    SqlxSegment(
                        kind="operation_sql",
                        text=inner,
                        start_line=line_at(open_brace + 1),
                        block_name=block_name,
                    )
                )
            else:
                segments.append(
                    SqlxSegment(
                        kind="raw", text=inner, start_line=line_at(open_brace + 1)
                    )
                )
            segments.append(
                SqlxSegment(
                    kind="raw", text=footer, start_line=line_at(close_brace)
                )
            )
        else:
            raw_block = content[match.start() : close_brace + 1]
            segments.append(
                SqlxSegment(
                    kind="raw", text=raw_block, start_line=line_at(match.start())
                )
            )

        pos = close_brace + 1

    return segments


def _mask_sqlx_expressions(
    sql: str, *, when_as_comment: bool = True
) -> tuple[str, dict[str, str], list[int]]:
    """Mask Dataform `${...}` expressions in SQL with BigQuery-safe tokens.

    Returns:
        masked_sql: SQL string with `${...}` replaced by deterministic tokens.
        placeholder_map: mapping of placeholder token -> original `${...}` text.
        line_map: 1-based original SQL line number for each 1-based masked line.
    """
    n = len(sql)
    i = 0
    out: list[str] = []
    placeholder_map: dict[str, str] = {}
    expr_to_token: dict[str, str] = {}
    counter = 0

    in_sq = False
    in_dq = False
    in_bt = False
    in_line_comment = False
    in_block_comment = False

    # Track line mapping: masked line index -> original line number (1-based)
    orig_line = 1
    line_map: list[int] = [1]

    def emit(s: str, src_line: int) -> None:
        out.append(s)
        newlines = s.count("\n")
        for _ in range(newlines):
            line_map.append(src_line)

    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""

        if in_line_comment:
            out.append(ch)
            if ch == "\n":
                in_line_comment = False
                orig_line += 1
                line_map.append(orig_line)
            i += 1
            continue

        if in_block_comment:
            out.append(ch)
            if ch == "\n":
                orig_line += 1
                line_map.append(orig_line)
            if ch == "*" and nxt == "/":
                out.append(nxt)
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_sq:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(nxt)
                if nxt == "\n":
                    orig_line += 1
                    line_map.append(orig_line)
                i += 2
                continue
            if ch == "\n":
                orig_line += 1
                line_map.append(orig_line)
            elif ch == "'":
                in_sq = False
            i += 1
            continue

        if in_dq:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(nxt)
                if nxt == "\n":
                    orig_line += 1
                    line_map.append(orig_line)
                i += 2
                continue
            if ch == "\n":
                orig_line += 1
                line_map.append(orig_line)
            elif ch == '"':
                in_dq = False
            i += 1
            continue

        if in_bt:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(nxt)
                if nxt == "\n":
                    orig_line += 1
                    line_map.append(orig_line)
                i += 2
                continue
            if ch == "\n":
                orig_line += 1
                line_map.append(orig_line)
            elif ch == "`":
                in_bt = False
            i += 1
            continue

        # Detect start of SQL comments or strings
        if ch == "-" and nxt == "-":
            in_line_comment = True
            out.append("--")
            i += 2
            continue
        if ch == "#":
            in_line_comment = True
            out.append("#")
            i += 1
            continue
        if ch == "/" and nxt == "*":
            in_block_comment = True
            out.append("/*")
            i += 2
            continue
        if ch == "'":
            in_sq = True
            out.append(ch)
            i += 1
            continue
        if ch == '"':
            in_dq = True
            out.append(ch)
            i += 1
            continue
        if ch == "`":
            in_bt = True
            out.append(ch)
            i += 1
            continue

        # Detect Dataform `${...}` template expression (skip escaped `\${`)
        if ch == "$" and nxt == "{" and (i == 0 or sql[i - 1] != "\\"):
            close_idx = _find_matching_brace(sql, i + 1)
            if close_idx != -1:
                expr = sql[i : close_idx + 1]
                expr_start_line = orig_line
                orig_line += expr.count("\n")

                is_when_clause = when_as_comment and bool(
                    re.match(r"^\$\{\s*when\s*\(", expr)
                )

                if is_when_clause:
                    token = f"/* __sqlx_when_{counter}__ */"
                    counter += 1
                    placeholder_map[token] = expr
                else:
                    if expr in expr_to_token:
                        token = expr_to_token[expr]
                    else:
                        token = f"__sqlx_expr_{counter}__"
                        counter += 1
                        expr_to_token[expr] = token
                        placeholder_map[token] = expr

                emit(token, expr_start_line)
                i = close_idx + 1
                continue

        out.append(ch)
        if ch == "\n":
            orig_line += 1
            line_map.append(orig_line)
        i += 1

    return "".join(out), placeholder_map, line_map


def _unmask_sqlx_expressions(
    masked_sql: str, placeholder_map: dict[str, str]
) -> tuple[str, bool]:
    """Restore masked placeholders back to exact Dataform `${...}` text.

    Returns (restored_sql, all_tokens_preserved).
    """
    if not placeholder_map:
        return masked_sql, True

    # Verify every placeholder injected is still present after fixing.
    for token in placeholder_map:
        if token not in masked_sql:
            return masked_sql, False

    # Replace longest tokens first so prefixes cannot collide.
    pattern = re.compile(
        "|".join(re.escape(tok) for tok in sorted(placeholder_map, key=len, reverse=True))
    )
    restored = pattern.sub(lambda m: placeholder_map[m.group(0)], masked_sql)
    return restored, True


def _build_rule_metadata(linter: Linter) -> dict[str, dict[str, Any]]:
    meta: dict[str, dict[str, Any]] = {}
    for rule in linter.get_rulepack().rules:
        meta[rule.code] = {
            "name": rule.name,
            "fixable": bool(rule.is_fix_compatible),
        }
    return meta


def _replace_placeholders_in_text(text: str, placeholder_map: dict[str, str]) -> str:
    """Replace any internal placeholder tokens in diagnostic messages."""
    if not placeholder_map or not text:
        return text
    pattern = re.compile(
        "|".join(re.escape(tok) for tok in sorted(placeholder_map, key=len, reverse=True))
    )
    return pattern.sub(lambda m: placeholder_map[m.group(0)], text)


def _collect_violations(
    result: Any,
    *,
    severity: str,
    section: str,
    segment_start_line: int,
    leading_newlines: int,
    line_map: list[int],
    file_lines: list[str],
    rule_meta: dict[str, dict[str, Any]],
    placeholder_map: dict[str, str],
    skip_codes: set[str] | None = None,
) -> list[Finding]:
    findings: list[Finding] = []
    for v in result.get_violations():
        code = v.rule_code()
        if skip_codes and code in skip_codes:
            continue
        masked_line = max(1, int(v.line_no))
        idx = min(masked_line - 1, len(line_map) - 1)
        orig_sql_line = line_map[idx] if line_map else masked_line
        abs_line = segment_start_line + leading_newlines + (orig_sql_line - 1)
        line_pos = max(1, int(v.line_pos))
        src_line = (
            file_lines[abs_line - 1].rstrip("\r\n")
            if 1 <= abs_line <= len(file_lines)
            else ""
        )
        desc = _replace_placeholders_in_text(v.description or "", placeholder_map)
        if code == "PRS":
            desc = re.sub(
                r"^Line \d+, Position \d+:",
                f"Line {abs_line}, Position {line_pos}:",
                desc,
            )
        rmeta = rule_meta.get(code, {})
        rule_name = rmeta.get("name") or RULE_GUIDANCE.get(code, {}).get("name", code)
        findings.append(
            Finding(
                rule_code=code,
                rule_name=rule_name,
                description=desc,
                line_no=abs_line,
                line_pos=line_pos,
                severity=severity,
                section=section,
                source_line=src_line,
                fixable_in_sqlfluff=bool(rmeta.get("fixable", False)),
            )
        )
    return findings


def _extract_leading_and_trailing_ws(text: str) -> tuple[str, str, str]:
    """Separate outer blank lines/whitespace while preserving indentation on line 1."""
    # Strip only full leading blank lines so indentation on the first SQL line
    # stays intact (important for dedenting pre_operations / post_operations).
    lines = text.splitlines(keepends=True)
    start_idx = 0
    while start_idx < len(lines) and not lines[start_idx].strip():
        start_idx += 1
    end_idx = len(lines)
    while end_idx > start_idx and not lines[end_idx - 1].strip():
        end_idx -= 1

    leading_ws = "".join(lines[:start_idx])
    trailing_ws = "".join(lines[end_idx:])
    core_raw = "".join(lines[start_idx:end_idx])
    core = core_raw.rstrip("\r\n")
    trailing_ws = core_raw[len(core) :] + trailing_ws
    return leading_ws, core, trailing_ws


def _normalize_segment_whitespace(
    seg: SqlxSegment,
    fixed_core: str,
    leading_ws: str,
    trailing_ws: str,
    *,
    has_preceding_block: bool,
    has_following_block: bool,
) -> str:
    """Re-attach clean section boundaries matching `.sqlfluff` newline rules."""
    if seg.kind == "operation_sql":
        # Inside `pre_operations { ... }` / `post_operations { ... }`, keep a
        # clean newline after `{` and before `}`.
        indented = "\n".join(
            ("    " + line if line.strip() else "") for line in fixed_core.splitlines()
        )
        return f"\n{indented}\n"

    # Main SQL body: allow at most 1 empty line (`\n\n`) after a preceding
    # `config {}` / `js {}` block, and preserve a trailing newline.
    prefix = "\n\n" if has_preceding_block else ""
    if has_following_block:
        suffix = "\n\n"
    else:
        suffix = "\n" if (trailing_ws.endswith("\n") or fixed_core) else ""
    return f"{prefix}{fixed_core}{suffix}"


def lint_sqlx_file(
    file_path: Path,
    repo_root: Path,
    std_linter: Linter,
    adv_linter: Linter,
    std_meta: dict[str, dict[str, Any]],
    adv_meta: dict[str, dict[str, Any]],
    *,
    apply_fix: bool = True,
) -> FileLintResult:
    rel_path = file_path.relative_to(repo_root).as_posix()
    try:
        original_content = file_path.read_text(encoding="utf-8")
    except Exception as exc:
        return FileLintResult(
            path=rel_path,
            status="error",
            notes=[f"Could not read file: {exc}"],
        )

    # Preserve line ending style (normalize internally to LF for SQLFluff).
    had_crlf = "\r\n" in original_content
    normalized_content = original_content.replace("\r\n", "\n")

    segments = split_sqlx(normalized_content)
    sql_segments = [s for s in segments if s.kind in ("sql", "operation_sql")]

    if not sql_segments:
        is_decl = bool(re.search(r'type\s*:\s*["\']declaration["\']', normalized_content))
        reason = "Dataform declaration (config-only, no SQL body)" if is_decl else "No SQL body found"
        return FileLintResult(path=rel_path, status="skipped", skip_reason=reason)

    fixed_counts: Counter[str] = Counter()
    notes: list[str] = []
    new_segment_texts: list[str] = []

    # Pass 1: Auto-fix each SQL segment with standard rules.
    for idx, seg in enumerate(segments):
        if seg.kind not in ("sql", "operation_sql"):
            new_segment_texts.append(seg.text)
            continue

        leading_ws, core, trailing_ws = _extract_leading_and_trailing_ws(seg.text)
        if not core:
            new_segment_texts.append(seg.text)
            continue

        # Dedent operation_sql inner block before linting so LT02 works cleanly.
        if seg.kind == "operation_sql":
            core_lines = core.splitlines()
            non_empty = [ln for ln in core_lines if ln.strip()]
            min_indent = min(
                (len(ln) - len(ln.lstrip(" ")) for ln in non_empty), default=0
            )
            working_core = "\n".join(
                ln[min_indent:] if len(ln) >= min_indent else ln for ln in core_lines
            )
        else:
            working_core = core

        masked_sql, placeholder_map, _ = _mask_sqlx_expressions(
            working_core, when_as_comment=True
        )
        # Ensure trailing newline for SQLFluff consistency while keeping LT12 excluded.
        masked_input = masked_sql + "\n"

        if apply_fix:
            pre_res = std_linter.lint_string(masked_input, fix=False)
            pre_codes = Counter(
                v.rule_code()
                for v in pre_res.get_violations()
                if v.rule_code() != "PRS"
            )

            fix_res = std_linter.lint_string(masked_input, fix=True)
            fixed_masked = fix_res.tree.raw.rstrip("\n")

            restored_core, ok = _unmask_sqlx_expressions(fixed_masked, placeholder_map)
            if not ok:
                notes.append(
                    f"Skipped auto-fix on {seg.block_name or 'main query'} segment: "
                    "a Dataform `${...}` placeholder was altered during fixing."
                )
                new_segment_texts.append(seg.text)
                continue

            post_check = std_linter.lint_string(fixed_masked + "\n", fix=False)
            post_codes = Counter(
                v.rule_code()
                for v in post_check.get_violations()
                if v.rule_code() != "PRS"
            )
            for code, before_n in pre_codes.items():
                delta = before_n - post_codes.get(code, 0)
                if delta > 0:
                    fixed_counts[code] += delta

            has_prev = idx > 0 and any(s.text.strip() for s in segments[:idx])
            has_next = idx + 1 < len(segments) and any(
                s.text.strip() for s in segments[idx + 1 :]
            )
            rebuilt = _normalize_segment_whitespace(
                seg,
                restored_core,
                leading_ws,
                trailing_ws,
                has_preceding_block=has_prev,
                has_following_block=has_next,
            )
            new_segment_texts.append(rebuilt)
        else:
            new_segment_texts.append(seg.text)

    updated_normalized = "".join(new_segment_texts)
    changed = apply_fix and (updated_normalized != normalized_content)

    if changed:
        final_disk_text = (
            updated_normalized.replace("\n", "\r\n") if had_crlf else updated_normalized
        )
        file_path.write_text(final_disk_text, encoding="utf-8")

    # Pass 2 & 3: Re-parse the final file content so EVERY line number matches
    # the exact post-fix state committed to the PR branch.
    final_segments = split_sqlx(updated_normalized)
    final_lines = updated_normalized.splitlines()

    unfixable_standard: list[Finding] = []
    advisory_warnings: list[Finding] = []

    for seg in final_segments:
        if seg.kind not in ("sql", "operation_sql"):
            continue

        leading_ws, core, _ = _extract_leading_and_trailing_ws(seg.text)
        if not core:
            continue

        leading_newlines = leading_ws.count("\n")
        section_name = seg.block_name or "query"

        if seg.kind == "operation_sql":
            core_lines = core.splitlines()
            non_empty = [ln for ln in core_lines if ln.strip()]
            min_indent = min(
                (len(ln) - len(ln.lstrip(" ")) for ln in non_empty), default=0
            )
            working_core = "\n".join(
                ln[min_indent:] if len(ln) >= min_indent else ln for ln in core_lines
            )
        else:
            working_core = core

        masked_sql, placeholder_map, line_map = _mask_sqlx_expressions(
            working_core, when_as_comment=True
        )
        masked_input = masked_sql + "\n"

        # Post-fix standard lint pass: catches PRS and any unfixable standard rules.
        std_post = std_linter.lint_string(masked_input, fix=False)
        std_findings = _collect_violations(
            std_post,
            severity="standard_unfixable",
            section=section_name,
            segment_start_line=seg.start_line,
            leading_newlines=leading_newlines,
            line_map=line_map,
            file_lines=final_lines,
            rule_meta=std_meta,
            placeholder_map=placeholder_map,
        )
        unfixable_standard.extend(std_findings)

        # Advisory lint pass: flags non-auto-fixed warnings (skip duplicate PRS).
        adv_res = adv_linter.lint_string(masked_input, fix=False)
        adv_findings = _collect_violations(
            adv_res,
            severity="advisory",
            section=section_name,
            segment_start_line=seg.start_line,
            leading_newlines=leading_newlines,
            line_map=line_map,
            file_lines=final_lines,
            rule_meta=adv_meta,
            placeholder_map=placeholder_map,
            skip_codes={"PRS", "TMP"},
        )
        advisory_warnings.extend(adv_findings)

    unfixable_standard.sort(key=lambda f: (f.line_no, f.line_pos, f.rule_code))
    advisory_warnings.sort(key=lambda f: (f.line_no, f.line_pos, f.rule_code))

    if unfixable_standard:
        status = "unfixable"
    elif changed:
        status = "fixed"
    else:
        status = "clean"

    return FileLintResult(
        path=rel_path,
        status=status,
        changed=changed,
        fixed_rule_counts=dict(sorted(fixed_counts.items())),
        unfixable_standard=unfixable_standard,
        advisory_warnings=advisory_warnings,
        notes=notes,
    )


def _format_suggestion_fence(lines_to_suggest: list[str]) -> str:
    body = "\n".join(lines_to_suggest)
    fence = "````" if "```" in body else "```"
    if body:
        return f"{fence}suggestion\n{body}\n{fence}"
    return f"{fence}suggestion\n{fence}"


def build_github_suggestions(
    file_path: Path,
    repo_root: Path,
    suggest_linter: Linter,
    rule_meta: dict[str, dict[str, Any]],
    *,
    kind_label: str = "Advisory",
) -> list[dict[str, Any]]:
    """Dry-run a fixable SQLFluff ruleset and return exact GitHub inline `suggestion` payloads."""
    rel_path = file_path.relative_to(repo_root).as_posix()
    try:
        original_content = file_path.read_text(encoding="utf-8")
    except Exception:
        return []

    normalized = original_content.replace("\r\n", "\n")
    segments = split_sqlx(normalized)
    sql_segments = [s for s in segments if s.kind in ("sql", "operation_sql")]
    if not sql_segments:
        return []

    orig_lines = normalized.splitlines()
    new_segment_texts: list[str] = []
    line_to_rules: dict[int, set[str]] = {}

    for idx, seg in enumerate(segments):
        if seg.kind not in ("sql", "operation_sql"):
            new_segment_texts.append(seg.text)
            continue

        leading_ws, core, trailing_ws = _extract_leading_and_trailing_ws(seg.text)
        if not core:
            new_segment_texts.append(seg.text)
            continue

        leading_newlines = leading_ws.count("\n")

        if seg.kind == "operation_sql":
            core_lines = core.splitlines()
            non_empty = [ln for ln in core_lines if ln.strip()]
            min_indent = min(
                (len(ln) - len(ln.lstrip(" ")) for ln in non_empty), default=0
            )
            working_core = "\n".join(
                ln[min_indent:] if len(ln) >= min_indent else ln for ln in core_lines
            )
        else:
            working_core = core

        masked_sql, placeholder_map, line_map = _mask_sqlx_expressions(
            working_core, when_as_comment=True
        )
        masked_input = masked_sql + "\n"

        pre_res = suggest_linter.lint_string(masked_input, fix=False)
        for v in pre_res.get_violations():
            code = v.rule_code()
            if code in ("PRS", "TMP"):
                continue
            masked_line = max(1, int(v.line_no))
            lm_idx = min(masked_line - 1, len(line_map) - 1)
            orig_sql_line = line_map[lm_idx] if line_map else masked_line
            abs_line = seg.start_line + leading_newlines + (orig_sql_line - 1)
            line_to_rules.setdefault(abs_line, set()).add(code)

        fix_res = suggest_linter.lint_string(masked_input, fix=True)
        fixed_masked = fix_res.tree.raw.rstrip("\n")
        restored_core, ok = _unmask_sqlx_expressions(fixed_masked, placeholder_map)
        if not ok or restored_core == working_core:
            new_segment_texts.append(seg.text)
            continue

        if seg.kind == "operation_sql":
            # Keep original indentation style cleanly
            indented = "\n".join(
                ("    " + ln if ln.strip() else "") for ln in restored_core.splitlines()
            )
            new_segment_texts.append(f"{leading_ws}{indented}{trailing_ws}")
        else:
            new_segment_texts.append(f"{leading_ws}{restored_core}{trailing_ws}")

    suggested_text = "".join(new_segment_texts)
    if suggested_text == normalized:
        return []

    suggested_lines = suggested_text.splitlines()
    matcher = difflib.SequenceMatcher(None, orig_lines, suggested_lines)
    suggestions: list[dict[str, Any]] = []

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue

        if tag == "insert":
            # GitHub suggestions must replace at least one existing line.
            if i1 > 0:
                start_idx = i1 - 1
                end_idx = i1
                replacement = [orig_lines[start_idx], *suggested_lines[j1:j2]]
            elif orig_lines:
                start_idx = 0
                end_idx = 1
                replacement = [*suggested_lines[j1:j2], orig_lines[0]]
            else:
                continue
        else:
            start_idx = i1
            end_idx = i2
            replacement = suggested_lines[j1:j2]

        start_line = start_idx + 1
        end_line = end_idx  # inclusive 1-based line number

        matched_rules: set[str] = set()
        for ln in range(start_line, end_line + 1):
            matched_rules.update(line_to_rules.get(ln, set()))
        rule_codes = sorted(matched_rules)

        if rule_codes:
            rule_header = ", ".join(f"`{c}`" for c in rule_codes)
            guidance_bullets = []
            for code in rule_codes:
                info = RULE_GUIDANCE.get(code)
                if info:
                    guidance_bullets.append(f"- **`{code}` (`{info['name']}`):** {info['guidance']}")
                else:
                    rname = rule_meta.get(code, {}).get("name", code)
                    guidance_bullets.append(f"- **`{code}` (`{rname}`):** Auto-generated SQLFluff fix.")
            guidance_md = "\n".join(guidance_bullets)
        else:
            rule_header = f"{kind_label} formatting"
            guidance_md = "- Suggested SQLFluff formatting adjustment."

        body = "\n".join(
            [
                f"💡 **SQLFluff {kind_label} Suggestion** ({rule_header})",
                "",
                guidance_md,
                "",
                _format_suggestion_fence(replacement),
            ]
        )

        suggestions.append(
            {
                "path": rel_path,
                "start_line": start_line,
                "line": end_line,
                "rule_codes": rule_codes,
                "kind": kind_label.lower(),
                "body": body,
            }
        )

    return suggestions


def _escape_md_cell(text: str, max_len: int = 180) -> str:
    cleaned = " ".join(text.replace("|", "\\|").split())
    if len(cleaned) > max_len:
        cleaned = cleaned[: max_len - 1] + "…"
    return cleaned


def _format_code_snippet(line: str, max_len: int = 100) -> str:
    stripped = line.strip()
    if not stripped:
        return "—"
    if len(stripped) > max_len:
        stripped = stripped[: max_len - 1] + "…"
    # Escape backticks inside inline code by switching fence length if needed.
    if "`" in stripped:
        return f"`` {stripped.replace('|', '\\|')} ``"
    return f"`{stripped.replace('|', '\\|')}`"


def render_pr_comment(
    report: dict[str, Any],
    *,
    repo: str = "",
    head_sha: str = "",
    lint_commit_sha: str = "",
    fork_pr: bool = False,
    suggestion_count: int = 0,
) -> str:
    """Render a detailed, structured GitHub PR Markdown comment."""
    files: list[dict[str, Any]] = report.get("files", [])
    checked_files = [f for f in files if f["status"] != "skipped"]
    skipped_files = [f for f in files if f["status"] == "skipped"]
    fixed_files = [f for f in files if f["changed"]]
    total_fixed_violations = sum(
        sum(f.get("fixed_rule_counts", {}).values()) for f in fixed_files
    )
    total_unfixable = sum(len(f.get("unfixable_standard", [])) for f in files)
    total_advisory = sum(len(f.get("advisory_warnings", [])) for f in files)
    total_errors = sum(1 for f in files if f["status"] == "error")

    blob_base = f"https://github.com/{repo}/blob/{head_sha}" if (repo and head_sha) else ""

    def line_link(path: str, line_no: int, line_pos: int) -> str:
        label = f"L{line_no}:{line_pos}"
        if blob_base:
            return f"[{label}]({blob_base}/{path}#L{line_no})"
        return f"`{label}`"

    def file_link(path: str) -> str:
        if blob_base:
            return f"[`{path}`]({blob_base}/{path})"
        return f"`{path}`"

    # Quality meter across checked SQLX files
    penalty = total_unfixable * 20 + total_errors * 35 + total_advisory * 4
    health_score = max(0, 100 - min(100, penalty)) if checked_files else 100
    filled_blocks = round(health_score / 20)
    block_emoji = "🟩" if health_score >= 85 else "🟨" if health_score >= 60 else "🟥"
    health_bar = (block_emoji * filled_blocks) + ("⬜" * (5 - filled_blocks))

    # Headline status + GitHub Alert callout
    if total_unfixable > 0 or total_errors > 0:
        headline_badge = "🚨 Action Required — Unfixable Standard Violations"
        alert_kind = "CAUTION"
        alert_text = (
            f"Found **{total_unfixable}** unfixable standard violation(s) and **{total_errors}** "
            f"file error(s) that block CI. Review the exact line links below."
        )
    elif total_advisory > 0 and fixed_files:
        headline_badge = "🛠️ Auto-Linted with Advisory Warnings"
        alert_kind = "TIP"
        alert_text = (
            f"Auto-fixed **{total_fixed_violations}** standard formatting issue(s) across "
            f"**{len(fixed_files)}** file(s). **{total_advisory}** non-blocking advisory warning(s) remain for review."
        )
    elif total_advisory > 0:
        headline_badge = "⚠️ Standard Checks Passed — Advisory Warnings Found"
        alert_kind = "NOTE"
        alert_text = (
            f"All enforced `.sqlfluff` rules passed! **{total_advisory}** advisory warning(s) "
            f"are surfaced below for optional cleanup."
        )
    elif fixed_files:
        headline_badge = "✨ Auto-Linted & Clean"
        alert_kind = "TIP"
        alert_text = (
            f"Auto-fixed **{total_fixed_violations}** standard formatting issue(s) across "
            f"**{len(fixed_files)}** file(s). Zero remaining violations!"
        )
    else:
        headline_badge = "✨ All Checks Clean"
        alert_kind = "TIP"
        alert_text = "Every changed `.sqlx` file passed all standard and advisory SQLFluff checks."

    lines: list[str] = [
        COMMENT_MARKER,
        f"### 🧹 SQLFluff SQLX Lint Report — {headline_badge}",
        "",
        f"> [!{alert_kind}]",
        f"> {alert_text}",
        "",
    ]

    # Auto-commit callout
    if lint_commit_sha and fixed_files:
        short_sha = lint_commit_sha[:7]
        commit_ref = (
            f"[`{short_sha}`](https://github.com/{repo}/commit/{lint_commit_sha})"
            if repo
            else f"`{short_sha}`"
        )
        lines.append(
            f"> [!NOTE]\n"
            f"> 🤖 Committed auto-lint fixes for **{len(fixed_files)}** `.sqlx` file(s) "
            f"({total_fixed_violations} standard rule fix(es)) to this PR branch in {commit_ref}."
        )
        lines.append("")
    elif fork_pr and fixed_files:
        lines.append(
            f"> [!WARNING]\n"
            f"> **Fork PR detected:** Found **{total_fixed_violations}** auto-fixable standard "
            f"issue(s) across **{len(fixed_files)}** file(s), but GitHub Actions cannot push "
            f"commits to a fork branch. One-click inline `suggestion` comments have been posted on your diff where possible, or run locally:\n"
            f"> ```sh\n"
            f"> uv run --with sqlfluff==4.5.0 python scripts/lint-sqlx.py --fix {' '.join(f['path'] for f in fixed_files)}\n"
            f"> ```"
        )
        lines.append("")

    # Summary table
    lines.extend(
        [
            "| Metric | Result | Details |",
            "| :--- | :---: | :--- |",
            f"| **SQLX Health Score** | {health_bar} **{health_score}%** | Based on post-fix violations across changed models |",
            f"| **📄 SQLX Files Checked** | **{len(checked_files)}** | {len(skipped_files)} skipped (declarations / no SQL body) |",
            f"| **🛠️ Auto-Fixed Files** | **{len(fixed_files)}** | {total_fixed_violations} standard violation(s) fixed automatically |",
            f"| **🚨 Unfixable Standard** | **{total_unfixable}** | Blocking `.sqlfluff` standard rules or parse errors |",
            f"| **⚠️ Advisory Warnings** | **{total_advisory}** | Non-blocking `.sqlfluff` advisory rules for review{f' · 💡 **{suggestion_count}** one-click suggestion(s) available via `/suggest`' if suggestion_count > 0 else ''} |",
            "",
        ]
    )

    # Section 1: Auto-fixed files summary
    if fixed_files:
        lines.extend(
            [
                "#### 🛠️ Auto-Fixed Standard Rules",
                "",
                "| File | Fixed Rules |",
                "| :--- | :--- |",
            ]
        )
        for f in fixed_files:
            rule_summary = ", ".join(
                f"`{code}` ({cnt})"
                for code, cnt in sorted(f.get("fixed_rule_counts", {}).items())
            )
            if not rule_summary:
                rule_summary = "Whitespace / section formatting"
            lines.append(f"| {file_link(f['path'])} | {rule_summary} |")
        lines.append("")

    # Section 2: Unfixable standard violations & parse errors
    unfixable_files = [f for f in files if f.get("unfixable_standard")]
    if unfixable_files:
        lines.extend(
            [
                "#### 🚨 Unfixable Standard Violations & Parse Errors (Action Required)",
                "",
                "These items are part of the enforced `.sqlfluff` standard ruleset (or SQL parse errors) and **could not be changed automatically** by `sqlfluff fix`.",
                "",
            ]
        )
        for f in unfixable_files:
            items = f["unfixable_standard"]
            lines.extend(
                [
                    f"**{file_link(f['path'])}** ({len(items)} issue(s))",
                    "",
                    "| Location | Rule | Description | Snippet |",
                    "| :--- | :--- | :--- | :--- |",
                ]
            )
            for item in items:
                loc = line_link(f["path"], item["line_no"], item["line_pos"])
                rule_cell = f"`{item['rule_code']}` (`{item['rule_name']}`)"
                desc_cell = _escape_md_cell(item["description"])
                snip_cell = _format_code_snippet(item.get("source_line", ""))
                lines.append(f"| {loc} | {rule_cell} | {desc_cell} | {snip_cell} |")
            lines.append("")

    # Section 3: Advisory warnings (flag-only, never auto-modified)
    advisory_files = [f for f in files if f.get("advisory_warnings")]
    if advisory_files:
        advisory_by_rule: Counter[str] = Counter()
        for f in advisory_files:
            for item in f["advisory_warnings"]:
                advisory_by_rule[item["rule_code"]] += 1

        lines.extend(
            [
                "#### ⚠️ Advisory Lint Warnings (Not Auto-Modified)",
                "",
                "These warnings come from the `.sqlfluff` advisory ruleset (`AL04, AM01, AM03, AM04, AM05, AM06, RF02, RF04, ST03, ST05, ST09, ST11`). SQLFluff flags them for manual review rather than auto-committing them. Comment `/suggest` (or tick the suggestion checkbox on the PR Mission Control card) to post one-click GitHub `suggestion` buttons for fixable advisory rules (`AM03`, `AM05`, `ST09`)!",
                "",
                "| Rule | Name | Count | Why Manual / Recommended Fix |",
                "| :--- | :--- | :---: | :--- |",
            ]
        )
        for code, count in sorted(advisory_by_rule.items()):
            info = RULE_GUIDANCE.get(code, {})
            rname = info.get("name", code)
            guidance = info.get("guidance", "Review manually.")
            lines.append(
                f"| `{code}` | `{rname}` | **{count}** | {_escape_md_cell(guidance, 180)} |"
            )
        lines.append("")

        use_collapsible = total_advisory > 12 or len(advisory_files) > 3
        for f in advisory_files:
            items = f["advisory_warnings"]
            per_file_rules = Counter(i["rule_code"] for i in items)
            rule_pills = ", ".join(
                f"`{c}` x{n}" for c, n in sorted(per_file_rules.items())
            )
            if use_collapsible:
                lines.append(
                    f"<details><summary><strong><code>{f['path']}</code></strong> — {len(items)} warning(s) ({rule_pills})</summary>"
                )
                lines.append("")
            else:
                lines.append(
                    f"**{file_link(f['path'])}** — {len(items)} warning(s) ({rule_pills})"
                )
                lines.append("")

            lines.extend(
                [
                    "| Location | Rule | Warning | Snippet |",
                    "| :--- | :--- | :--- | :--- |",
                ]
            )
            for item in items:
                loc = line_link(f["path"], item["line_no"], item["line_pos"])
                rule_cell = f"`{item['rule_code']}`"
                desc_cell = _escape_md_cell(item["description"])
                snip_cell = _format_code_snippet(item.get("source_line", ""))
                lines.append(f"| {loc} | {rule_cell} | {desc_cell} | {snip_cell} |")

            if use_collapsible:
                lines.append("")
                lines.append("</details>")
            lines.append("")
    elif checked_files and not unfixable_files:
        lines.extend(
            [
                "No remaining standard violations and no advisory warnings across the changed `.sqlx` files.",
                "",
            ]
        )

    # Notes & skipped files
    noted_files = [f for f in files if f.get("notes")]
    if noted_files:
        lines.append("#### Processing Notes")
        lines.append("")
        for f in noted_files:
            for note in f["notes"]:
                lines.append(f"- `{f['path']}`: {note}")
        lines.append("")

    if skipped_files:
        lines.append("<details><summary>Skipped SQLX files (no SQL body)</summary>")
        lines.append("")
        for f in skipped_files:
            lines.append(f"- `{f['path']}` — {f.get('skip_reason', 'Skipped')}")
        lines.append("")
        lines.append("</details>")
        lines.append("")

    # Footer metadata
    sqlfluff_ver = report.get("sqlfluff_version", "unknown")
    std_rules = ", ".join(report.get("standard_rules", []))
    adv_rules = ", ".join(report.get("advisory_rules", []))
    lines.extend(
        [
            "<details><summary>⚙️ Active <code>.sqlfluff</code> policy &amp; interactive commands</summary>",
            "",
            f"- **SQLFluff version:** `{sqlfluff_ver}` · **Dialect:** `bigquery` · **Indent:** `4 spaces` · **Commas:** `trailing`",
            f"- **Auto-fix standard rules:** `{std_rules}`",
            f"- **Advisory warning rules:** `{adv_rules}`",
            "- **Interactive PR commands:** `/suggest` (post one-click GitHub suggestions) · `/lint --fix` (re-run & commit) · `/compile <model>` (inspect compiled BigQuery SQL)",
            "",
            "</details>",
            "",
            "<sub>🧹 Maintained automatically by `sqlx-lint.yml` using `.sqlfluff`</sub>",
        ]
    )

    body = "\n".join(lines)
    # Guard against GitHub's 65,536-character PR comment limit.
    max_chars = 64000
    if len(body) > max_chars:
        body = (
            body[: max_chars - 250]
            + "\n\n> **Output truncated** to fit GitHub's comment size limit. "
            + "Inspect the workflow Job Summary or run `scripts/lint-sqlx.py` locally for the full list.\n"
        )
    return body


def emit_github_annotations(report: dict[str, Any]) -> None:
    """Emit GitHub Actions workflow commands for PR diff inline annotations."""
    for f in report.get("files", []):
        path = f["path"]
        for item in f.get("unfixable_standard", []):
            msg = item["description"].replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
            print(
                f"::error file={path},line={item['line_no']},col={item['line_pos']},"
                f"title=SQLFluff {item['rule_code']} ({item['rule_name']})::{msg}"
            )
        for item in f.get("advisory_warnings", []):
            msg = item["description"].replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
            print(
                f"::warning file={path},line={item['line_no']},col={item['line_pos']},"
                f"title=SQLFluff Advisory {item['rule_code']} ({item['rule_name']})::{msg}"
            )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Auto-fix and lint Dataform .sqlx files using .sqlfluff."
    )
    parser.add_argument(
        "files",
        nargs="*",
        help="Paths to .sqlx files to lint (relative to repo root or absolute).",
    )
    parser.add_argument(
        "--files-from",
        type=Path,
        help="File containing newline-separated .sqlx file paths to process.",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Lint all .sqlx files under definitions/.",
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path.cwd(),
        help="Repository root directory containing .sqlfluff (default: cwd).",
    )
    parser.add_argument(
        "--fix",
        action="store_true",
        help="Apply auto-fixes for standard rules in place.",
    )
    parser.add_argument(
        "--report-json",
        type=Path,
        help="Write structured JSON lint report to this path.",
    )
    parser.add_argument(
        "--render-comment",
        type=Path,
        help="Render PR Markdown comment from an existing JSON report instead of running lint.",
    )
    parser.add_argument(
        "--comment-md",
        type=Path,
        help="Write rendered Markdown PR comment to this path.",
    )
    parser.add_argument("--repo", default="", help="GitHub owner/repo for links.")
    parser.add_argument("--head-sha", default="", help="PR head commit SHA for links.")
    parser.add_argument(
        "--lint-commit-sha", default="", help="Auto-lint commit SHA pushed by CI."
    )
    parser.add_argument(
        "--fork-pr",
        action="store_true",
        help="Indicate PR originates from a fork where CI cannot push.",
    )
    parser.add_argument(
        "--annotations",
        action="store_true",
        help="Emit GitHub Actions ::warning / ::error annotations to stdout.",
    )
    parser.add_argument(
        "--fail-on-unfixable",
        action="store_true",
        help="Exit non-zero if any unfixable standard violations or parse errors remain.",
    )
    parser.add_argument(
        "--suggestions-json",
        type=Path,
        help="Write GitHub inline PR `suggestion` review comment payloads to this JSON file.",
    )
    parser.add_argument(
        "--suggest-rules",
        default=",".join(DEFAULT_SUGGEST_ADVISORY_RULES),
        help="Comma-separated fixable advisory rules to include in --suggestions-json (default: AM03,AM05,ST09).",
    )
    parser.add_argument(
        "--suggest-standard",
        action="store_true",
        help="Also generate inline GitHub `suggestion` payloads for standard rules (useful on fork PRs or --no-fix runs).",
    )
    parser.add_argument(
        "--suggestion-count",
        type=int,
        default=0,
        help="Optional count of available one-click suggestions to highlight in --render-comment mode.",
    )
    args = parser.parse_args(argv)

    # Render-only mode (used after git commit & push so comment includes commit SHA).
    if args.render_comment:
        report = json.loads(args.render_comment.read_text(encoding="utf-8"))
        md = render_pr_comment(
            report,
            repo=args.repo,
            head_sha=args.head_sha,
            lint_commit_sha=args.lint_commit_sha,
            fork_pr=args.fork_pr,
            suggestion_count=args.suggestion_count or report.get("summary", {}).get("suggestion_count", 0),
        )
        if args.comment_md:
            args.comment_md.write_text(md, encoding="utf-8")
        else:
            print(md)
        return 0

    repo_root = args.repo_root.resolve()
    config_path = repo_root / ".sqlfluff"
    if not config_path.exists():
        print(f"Error: .sqlfluff not found at {config_path}", file=sys.stderr)
        return 2

    target_paths: list[Path] = []
    raw_inputs: list[str] = list(args.files)
    if args.files_from and args.files_from.exists():
        raw_inputs.extend(
            ln.strip()
            for ln in args.files_from.read_text(encoding="utf-8").splitlines()
            if ln.strip()
        )
    if args.all:
        defs_dir = repo_root / "definitions"
        if defs_dir.exists():
            target_paths.extend(sorted(defs_dir.rglob("*.sqlx")))

    seen: set[Path] = set()
    for raw in raw_inputs:
        p = Path(raw)
        if not p.is_absolute():
            p = (repo_root / p).resolve()
        else:
            p = p.resolve()
        if p.exists() and p.suffix == ".sqlx" and p not in seen:
            seen.add(p)
            target_paths.append(p)

    # Deduplicate when combined with --all
    deduped: list[Path] = []
    seen_all: set[Path] = set()
    for p in target_paths:
        rp = p.resolve()
        if rp not in seen_all:
            seen_all.add(rp)
            deduped.append(rp)
    target_paths = sorted(deduped)

    import sqlfluff

    advisory_rules = parse_advisory_rules_from_config(config_path)
    std_cfg = FluffConfig.from_path(str(repo_root))
    adv_cfg = FluffConfig.from_path(
        str(repo_root), overrides={"rules": ",".join(advisory_rules)}
    )
    std_linter = Linter(config=std_cfg)
    adv_linter = Linter(config=adv_cfg)
    std_meta = _build_rule_metadata(std_linter)
    adv_meta = _build_rule_metadata(adv_linter)

    results: list[FileLintResult] = []
    for path in target_paths:
        res = lint_sqlx_file(
            path,
            repo_root,
            std_linter,
            adv_linter,
            std_meta,
            adv_meta,
            apply_fix=args.fix,
        )
        results.append(res)

    suggestions: list[dict[str, Any]] = []
    if args.suggestions_json:
        suggest_rules = [
            r.strip().upper() for r in args.suggest_rules.split(",") if r.strip()
        ]
        if args.suggest_standard:
            for path in target_paths:
                suggestions.extend(
                    build_github_suggestions(
                        path,
                        repo_root,
                        std_linter,
                        std_meta,
                        kind_label="Standard",
                    )
                )
        if suggest_rules:
            sug_cfg = FluffConfig.from_path(
                str(repo_root), overrides={"rules": ",".join(suggest_rules)}
            )
            sug_linter = Linter(config=sug_cfg)
            sug_meta = _build_rule_metadata(sug_linter)
            for path in target_paths:
                suggestions.extend(
                    build_github_suggestions(
                        path,
                        repo_root,
                        sug_linter,
                        sug_meta,
                        kind_label="Advisory",
                    )
                )
        args.suggestions_json.parent.mkdir(parents=True, exist_ok=True)
        args.suggestions_json.write_text(
            json.dumps(suggestions, indent=2), encoding="utf-8"
        )

    report = {
        "sqlfluff_version": getattr(sqlfluff, "__version__", "unknown"),
        "standard_rules": sorted(std_meta.keys()),
        "advisory_rules": advisory_rules,
        "summary": {
            "total_files": len(results),
            "checked_files": sum(1 for r in results if r.status != "skipped"),
            "skipped_files": sum(1 for r in results if r.status == "skipped"),
            "fixed_files": sum(1 for r in results if r.changed),
            "unfixable_standard_count": sum(len(r.unfixable_standard) for r in results),
            "advisory_warning_count": sum(len(r.advisory_warnings) for r in results),
            "error_files": sum(1 for r in results if r.status == "error"),
            "suggestion_count": len(suggestions),
        },
        "files": [asdict(r) for r in results],
    }

    if args.report_json:
        args.report_json.parent.mkdir(parents=True, exist_ok=True)
        args.report_json.write_text(json.dumps(report, indent=2), encoding="utf-8")

    if args.comment_md:
        md = render_pr_comment(
            report,
            repo=args.repo,
            head_sha=args.head_sha,
            lint_commit_sha=args.lint_commit_sha,
            fork_pr=args.fork_pr,
            suggestion_count=len(suggestions),
        )
        args.comment_md.parent.mkdir(parents=True, exist_ok=True)
        args.comment_md.write_text(md, encoding="utf-8")

    if args.annotations:
        emit_github_annotations(report)

    summary = report["summary"]
    print(
        f"SQLX lint complete: {summary['checked_files']} checked, "
        f"{summary['skipped_files']} skipped, {summary['fixed_files']} auto-fixed, "
        f"{summary['unfixable_standard_count']} unfixable standard violation(s), "
        f"{summary['advisory_warning_count']} advisory warning(s).",
        file=sys.stderr,
    )

    if args.fail_on_unfixable and (
        summary["unfixable_standard_count"] > 0 or summary["error_files"] > 0
    ):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

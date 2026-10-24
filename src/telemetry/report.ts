/** Markdown summary of ingested client telemetry. */
import type { Db } from "../db/index.js";
import { HEADLINE_FAILURE_OUTCOMES, OUTCOME_PRECEDENCE, type Outcome } from "../taxonomy.js";

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`;
}

/**
 * Per source: record count, counts by outcome, and failure rate. Failure rate uses the
 * headline definition (overcharge, non_delivery, wrong_goods, duplicate) over all records.
 * Note: client records never contain overcharge or duplicate (no reference price, no chain view).
 */
export function telemetryReport(db: Db): string {
  const sources = db
    .prepare(
      `SELECT s.source_id AS source_id, s.first_seen_at AS first_seen_at, COUNT(c.id) AS n
         FROM telemetry_sources s LEFT JOIN telemetry_calls c ON c.source_id = s.source_id
        GROUP BY s.source_id ORDER BY s.source_id`,
    )
    .all() as Array<{ source_id: string; first_seen_at: number; n: number }>;
  const byOutcome = db.prepare("SELECT outcome, COUNT(*) AS n FROM telemetry_calls WHERE source_id = ? GROUP BY outcome");

  const lines: string[] = ["# Client telemetry", ""];
  if (sources.length === 0) {
    lines.push("No telemetry records received.", "");
    return lines.join("\n");
  }
  let total = 0;
  let totalFail = 0;
  for (const s of sources) {
    const counts = new Map<string, number>();
    for (const row of byOutcome.all(s.source_id) as Array<{ outcome: string; n: number }>) counts.set(row.outcome, row.n);
    const failures = [...counts].filter(([o]) => HEADLINE_FAILURE_OUTCOMES.has(o as Outcome)).reduce((a, [, n]) => a + n, 0);
    total += s.n;
    totalFail += failures;
    lines.push(`## ${s.source_id}`, "");
    lines.push(`- First seen: ${new Date(s.first_seen_at).toISOString()}`);
    lines.push(`- Records: ${s.n}`);
    lines.push(`- Failure rate: ${pct(failures, s.n)} (${failures}/${s.n})`, "");
    lines.push("| Outcome | Records | Share |", "|---|---:|---:|");
    const ordered = [...OUTCOME_PRECEDENCE.filter((o) => counts.has(o)), ...[...counts.keys()].filter((o) => !OUTCOME_PRECEDENCE.includes(o as Outcome))];
    for (const o of ordered) lines.push(`| ${o} | ${counts.get(o)} | ${pct(counts.get(o)!, s.n)} |`);
    lines.push("");
  }
  lines.push(`**All sources:** ${total} records, failure rate ${pct(totalFail, total)} (${totalFail}/${total}).`, "");
  lines.push(
    "_Failure = overcharge, non_delivery, wrong_goods or duplicate. Client-side records cannot show overcharge (no reference price) or duplicate (no chain view)._",
    "",
  );
  return lines.join("\n");
}

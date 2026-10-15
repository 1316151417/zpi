import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { StateStore } from "../src/main/state-store.ts";
import { transcriptIndexesV2 } from "../src/main/transcript-schema.ts";

it("uses bounded open-call updates and run-start seeks with 100,000 historical calls/runs", () => {
  const state = new StateStore(":memory:");
  const db = state.db;
  try {
    db.exec(`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<100000)
      INSERT INTO transcript_calls SELECT 'long',n,'run-'||n,0,n*100,n*100+99,1 FROM rows;
      INSERT INTO transcript_calls VALUES ('long',100001,'active',0,10000100,10000101,0);
      INSERT INTO transcript_calls VALUES ('other',1,'active',0,100,101,0);
      INSERT INTO transcript_runs SELECT path,run_id,start,start+1,end,end+1,seq,0,NULL,NULL,NULL
      FROM transcript_calls WHERE complete=1;
      ANALYZE;`);
    const update = "UPDATE transcript_calls SET end=? WHERE path=? AND complete=0";
    const seek =
      "SELECT start,start_end FROM transcript_runs WHERE path=? AND start<=? ORDER BY start DESC LIMIT 1";
    const plan = (sql: string, args: (number | string)[]) =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...args)
        .map((row) => row.detail)
        .join("\n");
    const indexedUpdate = plan(update, [10000200, "long"]);
    const indexedSeek = plan(seek, ["long", 7654321]);
    expect(indexedUpdate).toContain("transcript_calls_open");
    expect(indexedSeek).toContain("transcript_runs_start");
    expect(indexedSeek).not.toMatch(/SCAN|TEMP B-TREE/);
    expect(db.prepare(seek).get("long", 7654321)).toEqual({ start: 7654300, start_end: 7654301 });
    const measure = () => {
      const statement = db.prepare(update);
      const start = performance.now();
      for (let i = 0; i < 40; i++) statement.run(10000200 + i, "long");
      return performance.now() - start;
    };
    const indexedMs = measure();
    expect(db.prepare("SELECT end FROM transcript_calls WHERE path='long' AND seq=100001").get()?.end).toBe(
      10000239,
    );
    expect(db.prepare("SELECT end FROM transcript_calls WHERE path='long' AND seq=100000").get()?.end).toBe(
      10000099,
    );
    expect(db.prepare("SELECT end FROM transcript_calls WHERE path='other'").get()?.end).toBe(101);
    db.exec("DROP INDEX transcript_calls_open; DROP INDEX transcript_runs_start; ANALYZE;");
    expect(plan(update, [10000200, "long"])).not.toContain("transcript_calls_open");
    expect(plan(seek, ["long", 7654321])).toContain("TEMP B-TREE");
    const baselineMs = measure();
    db.exec(transcriptIndexesV2);
    // Timings are evidence only; avoid a flaky wall-clock threshold on shared developer machines.
    console.info(
      JSON.stringify({
        historicalCalls: 100000,
        updates: 40,
        baselineMs,
        indexedMs,
        indexedUpdate,
        indexedSeek,
      }),
    );
  } finally {
    state.close();
  }
});

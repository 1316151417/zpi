# Indexed lazy restore benchmark — 2026-10-14

## Scope and reproduction

Run `node --import tsx scripts/benchmark-lazy-restore.ts 100,1024 1` from the repository root. This opt-in script creates large synthetic JSONL v2 fixtures, builds a real SQLite `HistoryIndex`, and opens/materializes them through `SessionManager.openAsync` / `materializeContext`. It does not launch Electron or call a model. Large fixtures are deleted after each case and are not part of default unit tests. Raw measurements are in [lazy-restore-2026-10-14.jsonl](benchmarks/lazy-restore-2026-10-14.jsonl).

Environment: Node v24.19.0, Linux 6.18.44, Intel Xeon Platinum 8573C, 9 reported logical CPUs, 9.73 GiB reported RAM. Shared cloud workspace, not the proposed fixed 8-core/16-GiB NVMe acceptance machine. SQLite WAL, synchronous=FULL, foreign_keys=ON, busy_timeout=5000.

Each case uses separate fresh processes for rebuild, warm-index metadata-only open, and warm-index open plus context. One measured process per phase/case; no 30-run distribution, p50, p95, or cold-cache claim. OS caches were not flushed; fixture writing and rebuild warm them. Other test activity can affect elapsed time.

Compressed fixtures have 80 retained user messages of 64 KiB each, exactly 5 MiB of retained text, plus a fixed summary and system snapshot. Forty retained messages precede C and forty follow C; K strictly precedes C (100 MiB: K=1518, C=1558; 1 GiB: K=16265, C=16305). All clocks tie to exercise sequence ordering. Both context message count and complete payload byte count are asserted, so truncated contexts fail the run. Uncompressed fixtures assert every message and its payload are present.

## Results

`readBytes` measures actual bytes requested by the HistoryIndex JSONL reader, not physical disk I/O or SQLite page reads. Parse counts instrument actual JSON.parse results with transcript seq/type, excluding header and SQLite checkpoint JSON. RSS delta is endpoint RSS minus pre-phase RSS, not a sampled phase peak. Lifetime maxRSS includes imports/startup. Raw records also include heapUsed, heapTotal, external, and ArrayBuffer endpoints.

| Fixture | Phase | Duration ms | JSONL read bytes | Parsed entries | RSS delta MiB | Process maxRSS MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 100 MiB C | rebuild | 1661.79 | 104,920,057 | 1,598 | 15.00 | 149.41 |
| 100 MiB C | open | 12.29 | 1 | 0 | 0.50 | 110.00 |
| 100 MiB C | context | 66.88 | 5,321,951 | 82 | 4.68 | 115.43 |
| 100 MiB U | rebuild | 1648.51 | 104,919,806 | 1,597 | 15.58 | 128.78 |
| 100 MiB U | open | 8.19 | 1 | 0 | 0.50 | 110.95 |
| 100 MiB U | context | 733.63 | 104,919,571 | 1,597 | 201.73 | 314.42 |
| 1024 MiB C | rebuild | 8566.30 | 1,073,816,995 | 16,345 | 18.01 | 149.27 |
| 1024 MiB C | open | 2.20 | 1 | 0 | 0.50 | 112.34 |
| 1024 MiB C | context | 43.87 | 5,322,198 | 82 | 4.75 | 116.57 |
| 1024 MiB U | rebuild | 6545.37 | 1,073,751,037 | 16,343 | 17.96 | 130.70 |
| 1024 MiB U | open | 2.71 | 1 | 0 | 0.50 | 111.19 |
| 1024 MiB U | context | 5847.99 | 1,073,750,802 | 16,343 | 1175.11 | 1286.86 |

The rebuild duration includes index loading and metadata-only SessionManager open. Context duration/read/parse counts exclude the preceding metadata-only open; context RSS delta uses the post-open baseline. Fresh-process warm opens read one newline byte and zero historical entries in all four cases. Both compressed contexts read approximately 5.08 MiB and parse 82 entries: C, K validation, and 80 retained messages. The context contains 82 messages including generated summary and system snapshot. The 1-GiB uncompressed case reads the full ~1 GiB and retains all 16,343 messages (1,071,054,848 text bytes); its ~1.15-GiB incremental RSS is real and is not described as constant memory.

## Interpretation and remaining acceptance work

These observations support bounded metadata-only open and effective-range reads on the measured fixtures. They do not constitute full storage-plan release acceptance. No measured warm open rescanned the historical JSONL; compressed reads remain constant when total history grows tenfold. Rebuild read each JSONL exactly once, with roughly 15–18 MiB endpoint RSS growth in this run.

Not measured here: cold-cache behavior, 30-process p50/p95, isolated event-loop delay, SQLite read/write page or byte counters, phase-sampled heap/external/ArrayBuffer peaks, temporary disk high-water marks, UI paging, fork/edit, million-short-record datasets, large single records, or actual provider request serialization. Lifetime maxRSS and endpoint measurements cannot prove all per-phase peak budgets. Synthetic fixtures use one compaction and text-only bodies; repeated compactions, signed/redacted content, images, and historical cutoffs are covered separately by small differential core tests. Real Electron/packaged-platform verification remains separate.

## Core correctness review

The core indexed path rejects the old full-array `getEntries` API, reads historical state through the store, materializes only selected context ranges, and keeps current task selection separate from transcript model identity. Review found and fixed an insufficient compaction boundary guard: K could be a non-tool entry while a later retained tool result referred to a declaration already summarized. Indexed projection now rejects a result without a declaration in its retained assistant turn; it does not silently insert old messages. Regression tests cover that case and valid repeated IDs in different retained turns, full signed/redacted assistant fields, image payloads, and JSON message serialization equivalence.

Final core suite: 39 files / 230 tests passed (19.77 seconds). The focused lazy-store suite: 12 tests passed. No GUI or live credentials used.

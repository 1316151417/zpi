# Assistant previews and sidebar parity

Reference: ZCode `872ad960de7ec172591f7e1952f7849229f94521` (3.14.0), checked out at `/Users/jiezhou/VSCodeProjects/ZCode`. Reference files are read-only. ZPI starts with a clean worktree, Node 24.12.0, npm. This spec precedes tests and implementation.

Implementation and recorded acceptance results: [delivery report, screenshots and limitations](../evidence/preview-sidebar/README.md). The table below records the original acceptance contract; the report maps it to the completed test cases.

## Behavior → implementation → evidence

| Reference behavior / source | ZPI owner / implementation | Acceptance contract |
| --- | --- | --- |
| `ConversationTurnGroup`, `useAssistantPreviewCardsForRow`: join all assistant text in a turn, terminal last text only | `Conversation` RunView projection + injected preview service | Real write/edit tools, streaming/aborted/history, multiple text segments |
| `assistantFileReferences`, `markdownFileLink`, `conversation-preview-artifacts`: exact candidate grammar, path resolution and directive boundaries | Pure UI preview parsing, no filesystem access | Table-driven paths/quotes/encoding/Windows/citations tests |
| MD/HTML require active turn changes, unique bare filename fallback | Existing Main `getChanges(sessionId, runId)`; in-flight request deduplication scoped to session/run/content | No-change, reverted, ambiguous, failed-read and missing-file cases |
| Localhost URLs, reverse position, normalized deduplication, 15 candidates / 10 validated cards | Pure candidate and validation functions; batch `checkPreviewFiles` IPC | URL matrix, prioritization, limits and delayed validation |
| Cards/OpenSplitButton and final-visible PPTX auto-open | UI cards + existing pane-store / fileAction / native open services | Real BrowserPane/FilePane/OfficePreview/native calls, menus, consumed keys |
| `WorkspaceSidebar`: independent project/timeline and created/updated preferences | One renderer preference store, localStorage with validation | Switch both independently, reload/restart, invalid values |
| `mapSessionSummaryToTaskMeta`, `taskListRowActivity`: activity time and live running authority | Main SessionHost + HistoryIndex; stamped event envelope → existing renderer store | Streaming updates, rename/pin/read stability, restart, stale running |
| `taskListOrdering`: running first, created/id for running, selected time/other time/id for idle | One pure comparator, reused before pagination | Equal-time ties, concurrent running updates |
| Relative time, two row layouts, overflow marquee | SidebarTaskRow + source-equivalent overflow component | Fixed clock, narrow width, hover/focus/touch and themes |
| Workspace page size 5, reset when not visible | Sidebar local limits keyed by project ID | 5/6/10/11, independent projects, collapse/view/remove resets |
| Tasks and timeline page size 20, single-direction more | Separate mounted list owners | 20/21/40/41, end/loading/stale hasMore guards |
| `taskTimelineGroups`: local calendar, language weeks, first-seen group order | Pure grouping after comparator and slice | Midnight/week/month boundaries, zh/en, running + groups |
| Zai theme tokens, file assets and Lucide geometry | Scoped CSS, existing matching assets | Original-source fixture vs ZPI screenshots, computed metrics, build assets |

## Product rules

- Preview extensions: `.md`, `.html`, `.htm`, `.docx`, `.xlsx`, `.pptx`, `.pdf`, `.mp4`, `.mov`, `.webm`, `.m4v`, `.mp3`, `.wav`, `.m4a`, `.ogg`, `.opus`, `.flac`, `.weba`. TXT and images do not become automatic cards.
- The full turn's text blocks are joined with two newlines. Rendering is anchored after its last text block, before message actions. Running turns never show cards. Completed and interrupted/aborted text can show cards; failed replies only qualify when their final text is represented as interrupted by the existing projection.
- Parsing priority: citation directives protect their entire ranges, then Markdown links, file URLs, balanced quoted paths, ordinary paths, shared fallback extraction. Unsupported citation kinds must not leak through generic extraction. An ordinary external HTTP link never becomes a local file or website card.
- Match MD/HTML to actual active changes using normalized full paths; a bare filename may match exactly one changed leaf. Fail closed on change-read errors. Office/PDF/media have no turn-change requirement. File stat always runs in Main and returns only existing regular files.
- Accept only source-supported `http(s)://localhost` / `127.0.0.1` URLs, without credentials and with legal ports. Preserve original HTTP route/query/hash. Do not probe connectivity. Any accepted HTTP preview suppresses HTML-file candidates. A localhost HTML pathname can carry a matching changed path and therefore require stat.
- Candidates are sorted by descending text position, deduplicated by normalized path or URL (root URL slash normalized), capped at 15, batch-validated, then capped at 10. Publish a whole validated snapshot; semantic identity rather than array identity drives requests. Old scope/signature responses never render in a new session.
- Deduplicate concurrent identical requests and keep a mounted row's validated snapshot. Remounting a historical conversation rechecks existence, as the reference validation effect does; completed filesystem checks are not an immutable cache. Deleting a file while its conversation is unmounted must suppress its card on return.
- PPTX auto-open only follows a running → successful completion observed in the currently visible conversation. Cold restored history and interrupted turns do not auto-open. Consume a scope/run/final-visible-PPTX-signature key once. Use ZPI's supported native open path when an embedded format viewer is unavailable.
- Cards: full content width, 12px top gap and inter-card gap; radius 12, 1px card border, padding 12 with right 16; icon container 44×44/radius 6/background; icon 24; title/subtitle 14px at default font, 20px line height, 4px gap; title medium/ellipsis; button 28px high, radius 8. Fade 900ms `cubic-bezier(.16,1,.3,1)`, delay `min(index*36,240)` ms; reduced motion disables it.
- Split button default opens an in-app preview, websites have “在浏览器中打开”; files list actual available open applications and absolute/relative copy actions. Reuse the existing native open capability rather than claiming unavailable remote editor integrations.
- Sidebar filter lives at the right of the task toolbar, 24px trigger / 14px ListFilter. Menu width 192, end aligned, 2px offset, 8px radius, source shadow and Radix navigation. View: Folder/Clock3; sort: MessageCircleCheck/MessageCirclePlus; trailing Check. No added status filters. ZPI has no grouped/remote/backround-work platform; preserve existing purpose-section reorder and task/project operations.
- Default preferences: project + updated. Persist independently and validate each value. This does not change section collapse preferences.
- `createdAt` is the session header timestamp; `updatedAt` is actual session activity, never read/list time or metadata mutation time. Main owns live running evidence; persisted status alone cannot prove running. Historical activity is derived from JSONL message/run entries, not metadata entries. No parallel metadata write path or synchronization delays.
- Compare idle tasks descending selected timestamp, descending other timestamp, then descending ID via `localeCompare`. Running tasks precede idle, compare descending createdAt then ID only. Pinned tasks keep ZPI's existing membership/order and are excluded from ordinary lists; drafts/archived tasks stay excluded.
- Relative time always reads updatedAt: floor minutes (<1 “刚刚”, <60 “N分”), floor hours (<24 “N小时”), floor days (“N天”). Hover/focus suppresses metadata in favor of actions; touch alone does not suppress metadata. ZPI has no permission/user-question waiting state; queued input is not such an interaction.
- Project pages grow 5 at a time, independently; collapse project / projects section / change view / remove project clears its limit. Sort changes retain project limits. Task and timeline pages grow 20; sort or workspace scope changes reset to 20. Unmounting the section resets its page; do not confuse section collapse with “show less”.
- More button: known more = hasMore OR total > visible count; while loading use known more; settled requires loaded count >= current limit AND known more. ZPI currently returns the entire local list, so total is exact and no additional RPC/page cache is introduced.
- Timeline aggregates visible projects plus unassigned/orphaned tasks. Sort and slice first, then group using selected time. Group order is first encounter, not a second chronological sort. Threshold order: today, yesterday, 2/3 days ago, this week, last week, this month, last month, older. Local midnight; Monday starts zh-CN weeks, Sunday en-US. Tasks section remains flat/default rows. Timeline rows have title + workspace label/time second line.

## State ownership and asynchronous order

```mermaid
sequenceDiagram
  participant Agent
  participant Main as SessionHost / HistoryIndex
  participant Store as Renderer store
  participant Row as Terminal turn / preview cache
  participant Pane as Existing pane-store
  Agent->>Main: text/tool/run events
  Main->>Main: stamp activity, persist message/run facts
  Main->>Store: ordered envelope(seq, activityAt, event)
  Store->>Row: terminal RunView + workspace scope
  Row->>Main: getChanges(session, run) if MD/HTML
  Main-->>Row: actual active changes (or failure)
  Row->>Row: candidates / signature / max 15
  Row->>Main: checkPreviewFiles(session, paths)
  Main-->>Row: batch stat results
  Row->>Row: scope/signature guard, publish max 10
  Row->>Pane: user open OR armed successful PPTX once
  Pane->>Main: read/open via existing IPC
  Note over Row,Pane: session switch invalidates publication; late opens remain scoped to originating task
```

```mermaid
flowchart LR
  JSONL[JSONL header + message/run entries] --> Index[HistoryIndex creation/activity projection]
  Runtime[SessionHost activeRuns] --> Records[SessionRecord snapshots + ordered events]
  Index --> Records
  Records --> Store[existing useStore sessions]
  Prefs[sidebar preference owner] --> Sort[one comparator]
  Store --> Sort
  Sort --> Page[visible limits: project 5 / tasks 20 / timeline 20]
  Page --> Groups[timeline first-seen calendar grouping]
  Page --> Flat[project and task rows]
  Groups --> Rows[timeline rows]
```

## Reference discrepancies and platform boundaries

- The requested `packages/ui/src/TaskTitleOverflowText.tsx` is actually `packages/ui/src/components/TaskTitleOverflowText.tsx`. It also includes a 1-second hover marquee (40px/s, minimum 6s, 24px repeat gap, 2s pause); replicate it.
- Timeline label is `2 天前` / `3 天前` (with a space). Group order follows first encounter even when running-first puts an older group ahead of today.
- Bare Home-relative prose is intentionally ignored; explicit balanced quote/link/citation handling differs. Preserve source behavior rather than expanding the accepted grammar.
- Source Web remote cards and remote editor targets require platform services absent from ZPI. There is no remote execution or background-work orchestration to copy.
- ZPI already previews DOCX/XLSX/media and uses BrowserPane for HTML/PDF. PPTX currently lacks an embedded viewer; preserve the requested native-open boundary and document the platform-dependent visible result.

## Verification plan

1. Focused Vitest: parsing/validation; ordering/preferences/pagination/calendar; Main activity and IPC filesystem validation. Include errors and races, not only snapshots.
2. Playwright: real fake-provider tool calls and actual temp files; history/restart; menu keyboard and default/native/browser actions; independent pagination and preference persistence.
3. Fixed clock/data, 1200×800 window, 280px sidebar, 14px UI and 100% zoom. Compare original reference components or their actual source-rendered fixtures against ZPI in Zai light/dark. Save source SHA, fixture context, screenshots, computed geometry and image diff. Explicitly distinguish fixture rendering from a full running ZCode installation.
4. `npm run check`, corresponding unit and desktop tests, `npm run build`, packaged/base-path asset verification. Record actual results and any limitations; no claim of perfect parity without evidence.

## Follow-up: expand/collapse all project groups

- Keep the toolbar's existing “项目” label unchanged pending design discussion.
- Follow `WorkspaceSidebar.handleToggleAllTaskGroups` and `tabStore` at the same reference SHA: show the 24px toggle beside the label only in project view with at least one project; use 14px Minimize2 / Maximize2 and “收起全部” / “展开全部” tooltips.
- “收起全部” applies only when the projects section and every visible project are expanded. It collapses that section and all its project groups. Otherwise “展开全部” opens the section and every visible project. Leave tasks, pinned items, and non-visible project preferences untouched.
- The existing interface preferences remain authoritative. One `updatePreferences` IPC call writes `projectsCollapsed` and `collapsedProjectIds` together; Main persists, the returned settings replace the existing renderer settings, and the existing visible-project effect resets pagination for collapsed groups. No extra state or delayed synchronization.
- Acceptance: all-expanded → collapse all; partially collapsed → expand all; section collapsed → expand all; no projects/timeline → hidden; tasks/pinned unchanged; settings restored on restart. This follow-up uses static checks only as requested; prior screenshots/test results predate this addition.

# Custom command composer and expansion

## Ownership and scope

The desktop command catalog is the authority for enabled custom commands from `~/.zpi/commands`
and the current project's `.zpi/commands`.
The shared composer consumes that catalog alongside existing `init`, `compact`, and skill suggestions.
It does not discover files, execute shell snippets, change models, or grant tool permissions.
`side` and `btw` remain unavailable. Existing `$` skill and `#` session behavior remains unchanged.

## Composer

- `/` opens a menu at a whitespace boundary. Commands appear first, then skills, then enabled subagents. Existing ZPI
  built-ins retain their catalog order; custom commands retain the catalog's name order.
- Search ranks case-insensitive prefixes, substrings, and subsequences against names, descriptions,
  and argument hints. Groups stay ordered while the best match across groups is selected initially.
- Slash rows match ZCode's text-only, one-line name/description layout, with 32px rows and 34px
  spacing, 14px text, a 40% name width cap, rounded selected/hover states and a bounded scroll list.
- Enter/Tab inserts the selection and a trailing space without submitting. Slash Up/Down clamps;
  Escape closes until the token changes. IME composition and modified Enter retain existing behavior.
- Completion replaces only the active token and a matching unfinished suffix, preserving unrelated
  following text. Skills selected from `/` preserve their existing canonical skill mention encoding.
- Commands serialize as plain `/name`, including in draft/history/queued input. Only built-ins or
  currently catalogued commands become command chips; unknown slash-like text remains ordinary text.
  Custom chips use a generic SquareSlash icon, not a command-derived asset URL.
- Subagents come from the desktop's effective session catalog, with disabled profiles and sessions
  without the subagent capability excluded. The third group uses bare names and descriptions.
  Selecting one inserts canonical `@name `, preserving the profile name's case, without sending or
  spawning. Known `@name` references render as atomic Bot chips in drafts and transcripts; unknown
  references stay text. No file reference, link destination, or new dispatch protocol is synthesized.
- On explicit send, the desktop keeps the original mention in display/history and routes the enabled
  profile through the existing Agent tool and its `subagent_type` contract. It must recheck effective
  session capabilities and profiles, so stale menu state cannot bypass a disabled subagent setting.

## Pure prompt expansion

The main-process helper recognizes a leading whole-input `/name` invocation and expands an already
loaded command body. Slash-nested and colon identifiers are supported without interpreting them as
filesystem paths. Built-in `init`/`compact` and removed `side`/`btw` are excluded from custom parsing.
File loading and selecting the user/project source label remain the caller's responsibility.

- `$ARGUMENTS` inserts the trimmed raw argument tail. `$1`, `$2`, etc. insert quote-aware positional
  values; missing positions are empty. Whitespace, quotes and backslash escaping are parsed without
  a shell. Expansion is a single pass over the original template: inserted user text is never re-expanded.
- Without placeholders, nonempty arguments append as `User arguments:` below the body.
- The model sees a short custom-command/source header and the expanded body; the transcript retains
  the original user invocation.
- Inline shell interpolation and fenced `!` shell blocks are parsed without running anything. The
  asynchronous helper accepts an injected shell runner; execution, timeout, output bounds and
  cancellation belong to the existing desktop Bash boundary. Explicit sending runs snippets
  sequentially, stops on error, and inserts output with trailing whitespace removed. Discovery,
  catalog/menu display, selecting a suggestion and queue admission never execute snippets.
  The synchronous helper fails closed when no runner is available.
- Shell segments are identified before argument expansion so user arguments cannot introduce new
  executable snippets. Arguments inside an existing shell segment remain part of that command.
  `@file` remains literal text. No implicit file reads, model overrides or tool allowances.

## Acceptance

Unit coverage checks grouping/ranking, reserved-name filtering, token replacement, catalog-only chips,
quoted/missing/literal arguments, single-pass expansion and unsupported dynamic shell syntax. Desktop
coverage checks menu/chip insertion without a send, keyboard bounds/Escape, actual custom invocation,
and unchanged built-in/skill behavior using isolated fake-model fixtures.

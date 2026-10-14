# Repository Guidelines

## Architecture & Scope

ZPI is a minimal coding desktop client: a ZCode-inspired interface with a Pi-style core. Apply the same minimalism to the client: keep the interface clean and direct, and prioritize the essential, frequently used features of everyday coding. Favor changes that save tokens and time while keeping the codebase small, maintainable, and easy to customize.

Keep the core's built-in tools limited to `read`, `write`, `edit`, and `bash`. The SDK may expose generic extension points, but must not depend on Electron or desktop orchestration. Desktop-only capabilities include structured questions, subagents, and persistent background commands; integrate them through `customTools` and `toolOverrides`, not desktop-specific branches in the core. Questions and subagents are enabled by default, configurable for new conversations, and snapshotted when a conversation first sends. Background commands remain available independently of those switches.

Preserve the absence of telemetry, built-in MCP, and an agent browser-control tool. The client browser preview is for the user; browser automation can use scripts through `bash` when dependencies are available. Reuse existing components and state owners, and remove obsolete code when replacing functionality. Side chats and subagents share their parent's working directory; a Git worktree isolates a checkout, not process permissions. The SDK remains a small supporting capability.

## Project Structure & Module Organization

- `packages/ai`: model providers, streaming, and transcript compatibility.
- `packages/agent`: agent execution loop.
- `packages/coding-agent`: sessions, tools, context, and SDK.
- `packages/ui`: shared React components, Markdown rendering, and styles.
- `packages/desktop/src`: Electron `main`, `preload`, `renderer`, and shared IPC contracts.
- Renderer assets live in `packages/desktop/src/renderer/assets` and `public`; retain their attribution in `THIRD_PARTY_NOTICES.md`.
- Node-based unit and service tests live in `packages/*/test`; Electron/Playwright tests, helpers, and fixtures live in `tests/`. Build scripts are in `scripts/`; SDK examples are in `examples/`.

## Build, Test, and Development Commands

Use Node.js 24 and npm. For initial setup, run `npm install --ignore-scripts`, `npm run install:electron`, and `npm run install:terminal` in order. Building the native terminal module on macOS requires Xcode Command Line Tools; rerun `npm run install:terminal` after upgrading Electron.

- `npm run dev`: start Electron and Vite with reload support.
- `npm run build`: build the desktop application.
- `npm run check`: run TypeScript and Biome checks.
- `npm run format`: apply Biome formatting and fixes.
- `npm run test:unit`: run Node-based Vitest tests; does not launch Electron or open application windows.
- `npm run test:unit -- packages/desktop/test/side-chat.test.ts`: run a focused test file.
- `npm run test:desktop`: build and run Playwright against real Electron processes, with hidden, non-focusable windows by default. See [development guidance](docs/development.md#测试) before running GUI tests.
- `npm run package:mac:preview`: create a Preview DMG in `release/`.

## Coding Style & Naming Conventions

Use strict TypeScript and ESM, two-space indentation, double quotes, and semicolons. Biome controls formatting with a 110-character line width. Use PascalCase for React component files and kebab-case for utility modules. Keep filesystem and privileged operations behind the Electron preload/IPC boundary.

## Testing Guidelines

Name tests by behavior: `*.test.ts` for Vitest and `*.spec.ts` for Playwright. Cover changed behavior and failure cases at the lowest useful layer; no numeric coverage threshold is configured. Prefer table-driven cases for equivalent inputs and reserve Electron tests for actual renderer/preload/main integration. Reuse fake providers, isolated temporary directories, and the shared desktop launcher; never depend on live model credentials, the user's clipboard, or opening their external applications. Run focused tests first, then the relevant broader suite. Packaged tests require an existing macOS app bundle; see [development guidance](docs/development.md#测试).

Keep README and development instructions aligned with actual defaults and commands. Specs and evidence under `docs/` include historical acceptance records; their old test counts, worktree states, and task-specific validation restrictions are not current contributor instructions.

## Commit & Pull Request Guidelines

- Follow the existing history: use concise English commit subjects in the imperative, such as `Fix mention alignment` or `Add file menus`. Conventional Commit prefixes are optional. Keep each commit focused on one coherent change; mention the version when the commit includes a release bump.
- Write PR titles around the resulting behavior. In the description, explain the problem, implementation, and validation; link relevant issues and include screenshots for visual changes. Report the checks actually run and any remaining limitations.
- Review the diff before committing. Keep credentials, local data, and generated build artifacts out of commits.

# Repository Guidelines

## Architecture & Scope

zpi is a minimal coding desktop client: a ZCode-inspired interface with a Pi-style core. Apply the same minimalism to the client: keep the interface clean and direct, and prioritize the essential, frequently used features of everyday coding. Favor changes that save tokens and time while keeping the codebase small, maintainable, and easy to customize.

Keep the core limited to `read`, `write`, `edit`, and `bash`; preserve the absence of telemetry, subagents, MCP, and background-task orchestration. Reuse existing components and remove obsolete code when replacing functionality. The SDK remains a small supporting capability.

## Project Structure & Module Organization

- `packages/ai`: model providers, streaming, and transcript compatibility.
- `packages/agent`: agent execution loop.
- `packages/coding-agent`: sessions, tools, context, and SDK.
- `packages/ui`: shared React components, Markdown rendering, and styles.
- `packages/desktop/src`: Electron `main`, `preload`, `renderer`, and shared IPC contracts.
- Renderer assets live in `packages/desktop/src/renderer/assets` and `public`; retain their attribution in `THIRD_PARTY_NOTICES.md`.
- Unit tests live in `packages/*/test`; desktop tests, helpers, and fixtures live in `tests/`. Build scripts are in `scripts/`; SDK examples are in `examples/`.

## Build, Test, and Development Commands

Use Node.js 24 and npm. For initial setup, run `npm install --ignore-scripts`, `npm run install:electron`, and `npm run install:terminal` in order. Building the native terminal module on macOS requires Xcode Command Line Tools; rerun `npm run install:terminal` after upgrading Electron.

- `npm run dev`: start Electron and Vite with reload support.
- `npm run build`: build the desktop application.
- `npm run check`: run TypeScript and Biome checks.
- `npm run format`: apply Biome formatting and fixes.
- `npm run test:unit`: run Vitest tests.
- `npm run test:desktop`: build and run Playwright desktop tests.
- `npm run package:mac:preview`: create a Preview DMG in `release/`.

## Coding Style & Naming Conventions

Use strict TypeScript and ESM, two-space indentation, double quotes, and semicolons. Biome controls formatting with a 110-character line width. Use PascalCase for React component files and kebab-case for utility modules. Keep filesystem and privileged operations behind the Electron preload/IPC boundary.

## Testing Guidelines

Name tests by behavior: `*.test.ts` for Vitest and `*.spec.ts` for Playwright. Cover changed behavior and failure cases; no numeric coverage threshold is configured. Reuse fake providers and isolated temporary directories. Run focused tests first. Packaged history tests require `npm run package:mac` beforehand or `ZPI_TEST_PACKAGED_APP` pointing to an existing bundle.

## Commit & Pull Request Guidelines

The repository currently has no commits, so no commit convention is established. Use concise, imperative messages describing the resulting change. PRs should explain the problem, implementation, validation, and relevant issues; include screenshots for visual changes. Keep credentials, local data, and generated build artifacts out of commits.

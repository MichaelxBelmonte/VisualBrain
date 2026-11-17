# Contributing to Visual Brain

Thanks for helping. Issues and pull requests are welcome, in English or Italian.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Visual Brain is local-first: nothing may leave the user's Mac without an explicit choice (see the analysis consent and the update feed). Keep it that way.
- Indexing reads files and never modifies them. Code that writes to the user's folders needs a clear, user-initiated action.

## Development setup

Requirements: macOS 13.5+, Node 24, and Rust only if you build the desktop app or the native walker.

```bash
npm install
npm run build:ui
node src/cli.ts serve --index   # http://127.0.0.1:4747
```

`npm run dev` rebuilds the interface on every change. Use a test profile so your real index is untouched:

```bash
VISUAL_BRAIN_DATA_DIR=/tmp/vb-dev node src/cli.ts serve
```

## Checks

Run what covers your change before opening a pull request:

```bash
npm run typecheck
npm run test:update     # updater, install location, folder permissions
npm run test:work       # workspace, teams, terminals, UI
npm run test:index      # indexing
node scripts/test-i18n.mjs
```

Desktop shell changes: `cargo test` in `app/src-tauri`.

## Style

- TypeScript with Node's native type stripping: no build step for the server, `esbuild` for the UI.
- Small functions, comments that say *why*. Follow the surrounding code.
- User-visible strings are written in Italian in the source; add the English text to `src/ui/locales/en.ts`.
- New behaviour comes with a test in `scripts/test-*.mjs`.

## Commits and pull requests

- One topic per pull request, with a short description of what changes for the user and how you tested it.
- Do not commit generated files (`dist/`, `release/`, `app/runtime/`), personal configuration (`brain.config.json`) or signing material (`.release-keys/`).

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).

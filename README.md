# Visual Brain

**English** · [Italiano](README.it.md)

A local map of the files on your Desktop. Every file, folder and project is a node; the relationships between them (imports, links, paths written inside files, copies, symlinks, shared identifiers, similar content, optional AI inferences) are edges, each with its evidence and a confidence. From any node you can start Claude Code, Codex or Hermes already pointed at that node, alone or as a coordinated team.

Everything runs on your Mac: Node 24, SQLite (`node:sqlite`), a 2D canvas and an optional Rust walker. Indexing never calls an AI model. The optional semantic analysis sends only metadata to the model, plus README excerpts if you explicitly allow it, and shows you exactly what would be sent first.

## Install the app

1. Download the latest `Visual-Brain-X.Y.Z-mac-universal.zip` from the [releases](https://github.com/MichaelxBelmonte/VisualBrain-releases/releases/latest).
2. Unzip it and drag **Visual Brain.app** into **Applications** before opening it.
3. On first launch choose Italian or English and the folders to map: nothing is scanned before you choose.

Requires macOS 13.5 or later (Apple Silicon and Intel). Node is bundled: no npm, Rust or developer tools needed. The app updates itself from a signed feed, always into Applications, without closing your terminals.

The package uses a stable self-signed identity and is not notarized, so macOS may ask you to approve the first launch in **System Settings › Privacy & Security**. The first time it reads your Desktop macOS asks for permission; if access is refused, a notice in the app explains how to allow it.

Your index, settings and boards stay in `~/Library/Application Support/Visual Brain/` (logs in `logs/`). Scans only read the folders you chose and never modify files. Agents you launch may modify files, according to your instructions and their CLI's permissions. Claude Code, Codex and Hermes are optional; each user installs and signs in with their own account. Claude Code and Codex can also run under several accounts at once (Settings → Agents → the provider's card → Add account; pick the account from the Agent menu when launching). Every account, the main one included, can be renamed there; the name is shown next to each Claude Code and Codex session. The same cards show each CLI's installed version and whether a newer one is out; *Update* runs the CLI's own update command in the background, without a terminal (also listed in Settings → Updates). Sessions already open keep their version until restarted.

## Features

- **Map.** An ordered layout, not a force graph: **areas** are grey groups, each **project** is a box, folders open in place with nested files. Solid lines are facts found in the files, dashed lines hypotheses (similar text, AI), dotted lines rules. Positions are stable across launches.
- **Search** (`⌘K`) for files, folders and projects; the result opens in the map.
- **Node panel**: details, links with the evidence for each one, content, notes, *Open on the Mac*, *Work on this* with an agent.
- **Workspace.** Real terminals (node-pty + xterm.js) next to the node they work on, one at a time or up to four side by side. Terminals survive closing and reopening the app.
- **Teams.** An orchestrator and operators on the same node, each with its own CLI, model and effort; a board per node (To do, In progress, Needs you, Done), a **Main Brain** that coordinates squads, optional Git worktrees, and reminders. See [docs/TEAM.md](docs/TEAM.md).
- **Node harnesses**: installs and opens DeepSeek Harness or Harness² from a node. See [docs/HARNESSES.md](docs/HARNESSES.md).
- **Local API** that agents use to enrich the graph: [docs/API.md](docs/API.md).

## Run from source

```bash
npm install            # once
npm run build:ui       # builds the interface into dist/ui
node src/cli.ts index  # first index of ~/Desktop
node src/cli.ts serve  # http://127.0.0.1:4747
```

`npm run dev` serves with the interface rebuilt on every change; `vb` (`bin/vb.js`) is the same CLI. The server watches the mapped folders and re-indexes what changes (`--no-watch` turns it off).

| Command | What it does |
|---|---|
| `vb index [--root DIR] [--subtree DIR] [--reextract] [--engine ts\|native\|auto]` | incremental scan, extraction, projects, edges, ranking |
| `vb serve [--port N] [--no-watch] [--watch-ui] [--open] [--index]` | HTTP + WebSocket server |
| `vb stats` | index numbers and edges by kind |
| `vb analyze [--consent metadata\|excerpts] [--dry-run]` | semantic analysis with a model; `--dry-run` prints exactly what would be sent |

Start the server from a regular terminal, not from inside a Claude Code session: agents inherit the server's environment and would start as child sessions.

## Build the Mac app

```bash
npm install
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run package:mac    # universal ZIP and checksum in release/
npm run install:mac    # package, install into /Applications, remove the build copy
```

`install:mac` keeps exactly one Visual Brain on the Mac, the one in Applications; open terminals stay alive (⌘R loads the new interface). The build downloads Node from nodejs.org and checks its SHA-256. Without a signing identity the build is ad-hoc signed; set `APPLE_SIGNING_IDENTITY` (and `VB_NOTARY_PROFILE` to notarize) for a Developer ID build. Releases and the update feed: [docs/RELEASES.md](docs/RELEASES.md).

## Configuration

In CLI mode an optional `brain.config.json` in the project root (git-ignored; start from `brain.config.example.json`) overrides the defaults in `src/server/config.ts`: `roots`, `port`, `excludePaths` (added to the defaults: put the private folders you never want read here), `vendorNames`, `secretPatterns`, `containers` / `notContainers`, `llm` (`provider`: `claude-cli` | `anthropic-api` | `none`, `model`, `effort`, `consent`), `agents`. The desktop app keeps its settings in `settings.json` in its profile.

Never read: excluded folders, `.env*` files, keys and credentials (indexed by name only, class `secret`). Folders such as `node_modules`, `target`, `venv`, `.build` count only as totals.

**Several brains (e.g. Mac and a VM).** The server runs without the app: `VISUAL_BRAIN_DATA_DIR=<profile> node src/cli.ts serve --port N`, with `roots`, `setupComplete: true`, `"llm": {"provider": "none"}` and a `"label"` in `<profile>/settings.json`. It only accepts the Host `127.0.0.1:N` / `localhost:N`, so an SSH tunnel must use the same port on both sides.

## Tests

```bash
npm run typecheck
npm run test:update    # updates, install location, folder permissions
npm run test:work      # workspace, teams, terminals, interface
npm run test:index     # indexing engines and graph quality
```

Indexing engines, benchmarks and their limits: [docs/INDEXING.md](docs/INDEXING.md), [docs/INDEXING-BENCHMARK.md](docs/INDEXING-BENCHMARK.md).

## Layout

```
src/server/   scan · classify · extract · projects · graph · rank · cache · api · server
              terminals · launch · team · updater · access · llm/
src/ui/       main · layout · graph (canvas) · panel · search · terminal · work board · settings
src/shared/   types.ts (UI/API contract)
app/          Tauri desktop shell (Rust)
native/       optional Rust walker
scripts/      build, packaging, release and test scripts
docs/         API, indexing, teams, harnesses, releases (mostly in Italian)
```

## Contributing

Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Michael Belmonte. Bundled tree-sitter grammars are MIT licensed: [vendor/tree-sitter/LICENSES.txt](vendor/tree-sitter/LICENSES.txt).

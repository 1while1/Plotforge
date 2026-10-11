# Plotforge

**[English](README.md)** · [简体中文](README.zh-CN.md)

[![CI](https://github.com/1while1/Plotforge/actions/workflows/ci.yml/badge.svg)](https://github.com/1while1/Plotforge/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/1while1/Plotforge)](https://github.com/1while1/Plotforge/releases/latest)
[![License](https://img.shields.io/github/license/1while1/Plotforge)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-24-417e38)](https://nodejs.org/)

A local-first AI writing studio for long-form creators. Plotforge runs on your own machine with Node.js, organizes stories into books, volumes and chapters, and connects to OpenAI-compatible model providers. Story data is stored in a local SQLite file.

## Features

- **Writing workbench**: a chapter sidebar, text editor and AI panel; focus mode keeps the manuscript and AI input visible, while narrow screens use sidebar drawers.
- **Appearance and shortcuts**: light, dark and system themes; adjustable accent color, text font and line width; `Ctrl+K` navigation and shortcuts for saving, switching chapters, finalizing and focus mode.
- **Streaming writing conversations**: one active chat run per book, cancellation on disconnect, interrupted-run recovery and visible writing status. The server distinguishes manuscript output from discussion; inserted prose is saved automatically, and chat follows new messages.
- **Outline workbench**: a chapter timeline, beat editing and drag-and-drop ordering, pacing indicators, suggestions for missing chapters, AI pacing feedback and volume summaries.
- **Agent workspace**: separate read-only discussion and writing execution modes, with tools allowed according to the task profile.
- **Characters, worldbuilding and story ledger**: AI proposes changes; accepted story events are recorded with optimistic locking and an audit trail.
- **Context management**: a budgeted context-provider pipeline, four-section conversation summaries, summary inheritance across compression, stale-source detection and per-conversation usage and context breakdowns.
- **BYOK providers and models**: add providers, edit keys and model lists, and choose the active model. Keys stay in the local server database; configuration responses return masked values.
- **Local retrieval-augmented generation (RAG)**: chapter text is split into chunks and indexed with local embeddings using `@huggingface/transformers`. Same-book cosine top-k retrieval supports the context pipeline, evidence search and LLM tools; embedding computation stays on your machine.
- **Style library**: manage author style cards with a persona, fingerprint, rules and examples, and run style checks.
- **Local persistence**: a single sql.js (SQLite WASM) database file, with a single-instance lock and automatic backups; no external database service required.

## Quick start

Node.js 24.x is recommended. Node.js 22.13+ (22.x) and 26+ are also supported.

Download and extract the source from the [latest Release](https://github.com/1while1/Plotforge/releases/latest), open the project directory and run:

```bash
npm ci
npm run build   # Build the React + Vite frontend into public/
npm start
```

Open http://localhost:3000. In **Settings → Model API** (设置 → 模型接口), add an OpenAI-compatible provider with its base URL, API key and model list, then activate a model. The application interface is currently in Chinese; this language switch changes the GitHub documentation.

The first launch downloads the local embedding model (about 90 MB) for chapter indexing and retrieval. Once it is cached, local writing, storage and embedding retrieval can work offline. Cloud LLM calls still require a network connection.

Override the port with `PORT=8080 npm start`. For frontend development, `npm run dev` starts Vite with hot reload. Its proxy defaults to `http://127.0.0.1:3110`; set `MOZHEN_DEV_ORIGIN` to use another backend address.

## Dependency security updates on dev

The `dev` branch includes dependency security fixes; the current stable Release is still 1.2.0. Use the `dev` branch source to try these updates. A stable version will follow after validation.

Local embeddings now use the Hugging Face Transformers.js q8 CPU runtime. The default model cache is `data/embedding-cache`; set `NOVEL_EMBED_CACHE_DIR` to change it, or `HF_ENDPOINT` to change the model download endpoint.

When upgrading from an older version:

1. Stop your own application instance and back up `data/novel.db`.
2. Before running `npm ci`, copy the contents of the old `node_modules/@xenova/transformers/.cache` model cache into `data/embedding-cache` (or your configured cache directory). Without an existing cache, the first launch needs a network connection to download the model.
3. Run `npm ci` and `npm run build`, then start the application. Migration 033 invalidates old chapter and style-example vectors while preserving text and other business data. Finalized chapters are reindexed automatically; semantic retrieval may temporarily fall back during rebuilding. Maintainers using offline semantic style-example selection must rebuild the relevant style-pack vectors with `server/style/retrieve.indexSamples(packId)`.

To roll back, use the pre-upgrade database backup with its matching dependencies. Avoid mixing vectors from the two runtimes.

## Demo data

The repository contains no real manuscripts. To explore the workbenches, seed two fictional example stories, each with one volume, four chapters, characters and worldbuilding entries:

```bash
node tools/seed-demo.js
```

Running it again is safe: books with the same title are skipped. You can also use `npm run seed`; set `NOVEL_DB_FILE` to seed an isolated temporary database.

## Tests

```bash
# Use an isolated temporary database to protect your local data (bash / zsh)
NOVEL_DB_FILE="$(mktemp -d)/qa.db" npm test
npm run test:fe  # Frontend component tests (Vitest)
```

Windows PowerShell:

```powershell
$env:NOVEL_DB_FILE = Join-Path ([IO.Path]::GetTempPath()) ("plotforge-qa-" + [guid]::NewGuid() + ".db")
npm test
npm run test:fe
Remove-Item Env:NOVEL_DB_FILE
```

## Technology stack

- Frontend: React 19 + react-router + Vite, Tailwind CSS 4 and Radix UI (`frontend/`, with built assets served by Express).
- Backend: Node.js + Express 5; sql.js (SQLite WASM), persisted to `data/novel.db`.
- Retrieval: local `@huggingface/transformers` embeddings and cosine search (`server/vector/`); vectors live in the same SQLite database.
- LLM: OpenAI-compatible protocol, with provider and model selection in Settings.

## Project structure

```text
frontend/  React application source: pages, components, hooks and libraries
public/    Built frontend and static assets
server/    Express routes, domain services, context pipeline, LLM gateway and tools
test/      node:test unit and integration tests
tools/     Command-line tools for seeding, backups and distillation
```

## Versions and contributing

- [Releases and downloads](https://github.com/1while1/Plotforge/releases) · [Changelog](CHANGELOG.md)
- [Bug reports and feature requests](https://github.com/1while1/Plotforge/issues/new/choose) · [Contributing guide](CONTRIBUTING.md)
- [Security information and private vulnerability reporting](SECURITY.md)

Stable versions use `vMAJOR.MINOR.PATCH` tags. Prefer the latest stable Release for downloads. Releases currently provide source code; install dependencies and build using the steps above.

Branch policy: `main` is the stable, default branch. `dev` receives the latest sanitized code for validation and testing. After stability is confirmed and CI passes, maintainers fast-forward `main` to the selected `dev` commit. CI does not promote automatically. Target `dev` for feature and dependency pull requests.

## License

[MIT](LICENSE)

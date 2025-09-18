# Repository Guidelines

## Project Structure & Module Organization
The root contains the Playwright automation scripts and helper utilities:
- `greenit-kpi-runner.js` orchestrates KPI runs using settings from `config.yml`.
- `greenit-kpi-runner-v3.9.7.js` is the upstream runner kept for comparisons; avoid editing without syncing from source.
- `capture-session.js` captures authenticated storage state; outputs land under `out/auth`.
- Generated assets (reports, screenshots, storage states) live in `out/`; keep it out of commits.
- `pw-profile/Default` holds optional Playwright user data when a persistent profile is required.

## Build, Test, and Development Commands
Run `npm install` once. Day-to-day commands:
- `npm run kpi` -> executes the main runner with `config.yml`, writing reports to `out/`.
- `npm run kpi:session` -> same as above but keeps session data for successive runs.
- `npm run session:capture` -> launches an interactive browser to record `out/auth/storageState.json`.
- `node kpi-compare.cjs --base ... --head ... --out ...` -> compares two report snapshots; store artifacts inside `out/reports/`.

## Coding Style & Naming Conventions
Write modern ECMAScript modules with 2-space indentation and trailing commas omitted. Use `camelCase` for variables/functions, `SCREAMING_SNAKE_CASE` for env vars (e.g. `KPI_USER`). Keep CLI flags in `kebab-case`. Update `config.yml` with descriptive scenario keys and inline comments when behavior differs. Whenever modifying vendor files, document the delta in the PR description.

## Testing Guidelines
We rely on Playwright-driven smoke tests via the KPI runner. Always validate changes by running `npm run kpi` against a staging target and inspect `out/reports/*/index.html`. Use `kpi-compare.cjs` to detect regressions between two recorded runs. Capture fresh sessions with `npm run session:capture` whenever authentication flows change, and delete stale state files before committing. Highlight any manual assertions or metrics you verified in the PR.

## Commit & Pull Request Guidelines
Commits should stay focused, written in the imperative mood (`Add capture helper`). Reference ticket IDs when available. Before opening a PR, summarize the scenario exercised, link to relevant reports inside `out/`, and mention any secrets required (use env var names, never raw values). Include screenshots of KPI diffs when helpful. Request review from automation owners when touching runner logic, and flag any follow-up cleanup in the PR notes.

## Security & Configuration Tips
Keep credentials in local shells or secrets managers; never check them in. Prefer overriding sensitive settings via env vars (`KPI_USER`, `KPI_PASS`) rather than editing `config.yml`. If you must store example configs, redact secrets and document restoration steps. Clean the `out/` directory before publishing artifacts externally.

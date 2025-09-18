# Green IT Crawler - Development Guide

## Build/Test/Lint Commands
- `npm install` - Install dependencies
- `npm run kpi` - Run KPI analysis with config.yml, outputs to out/
- `npm run kpi:session` - Run KPI analysis with persistent session data
- `npm run session:capture` - Launch interactive browser to capture auth state
- `node kpi-compare.cjs --base <dir> --head <dir> --out <dir>` - Compare two KPI reports

## Code Style & Conventions
- **Module Type**: ES modules (`type: "module"` in package.json)
- **Indentation**: 2 spaces, no trailing commas
- **Naming**: camelCase for variables/functions, SCREAMING_SNAKE_CASE for env vars (KPI_USER, MP_PASS)
- **CLI Flags**: kebab-case (--ignore-https-errors, --persist-session)
- **Imports**: Use destructuring for specific imports, namespace imports for large modules
- **File Structure**: Keep generated assets in out/, exclude from commits
- **Config**: Use config.yml for scenarios, env vars for secrets (never commit credentials)

## Key Files
- `greenit-kpi-runner.js` - Main orchestrator (edit this)
- `greenit-kpi-runner-v3.9.7.js` - Upstream reference (don't edit without syncing)
- `capture-session.js` - Auth state capture utility
- `config.yml` - Test scenarios and KPI thresholds
- `out/` - Generated reports, screenshots, auth states (gitignored)

## Testing & Validation
- Run `npm run kpi` against staging targets to validate changes
- Check `out/reports/*/index.html` for KPI results
- Use `kpi-compare.cjs` to detect regressions between runs
- Capture fresh auth with `npm run session:capture` when login flows change
- Clean out/ directory before external artifact sharing

## Environment Variables
- `MP_USER`, `MP_PASS` - MySanteClair credentials
- `STC_USER`, `STC_PASS` - Santeclair Solution credentials
- `KPI_USER`, `KPI_PASS` - Generic KPI runner credentials
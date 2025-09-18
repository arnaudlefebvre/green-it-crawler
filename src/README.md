# Modular Green IT Crawler

This directory contains the refactored, modular version of the Green IT KPI runner.

## Architecture

```
src/
├── crawler/
│   ├── browser-manager.js     # Browser/context setup & teardown
│   ├── page-crawler.js        # Page navigation & data collection
│   └── auth-handler.js        # Authentication & session management
├── kpi/
│   ├── metrics-calculator.js  # Raw metrics computation
│   ├── kpi-scorer.js         # KPI scoring & grading logic
│   └── impact-estimator.js   # Environmental impact calculations
├── reporting/
│   ├── report-generator.js    # Markdown report generation
│   ├── csv-exporter.js       # CSV/JSONL export
│   └── diff-generator.js     # Report comparison logic
├── utils/
│   ├── file-helpers.js       # File operations & path utilities
│   ├── network-helpers.js    # URL/domain/content-type utilities
│   └── config-loader.js      # Configuration parsing
└── main.js                   # Main orchestrator
```

## Benefits

- **Separation of Concerns**: Each module has a single responsibility
- **Testability**: Individual modules can be unit tested
- **Reusability**: Components can be reused across different runners
- **Maintainability**: Easier to locate and modify specific functionality
- **Extensibility**: New features can be added without touching core logic

## Usage

Run the modular version using:

```bash
# Basic run
npm run kpi:modular

# With persistent session
npm run kpi:modular:session

# Direct node execution
node src/main.js --config config.yml --out out
```

## Module Responsibilities

### crawler/
- **browser-manager.js**: Handles Playwright browser context creation and teardown
- **page-crawler.js**: Manages page navigation, response collection, and DOM analysis
- **auth-handler.js**: Handles login flows and session persistence

### kpi/
- **metrics-calculator.js**: Computes raw metrics from collected data (requests, DOM size, etc.)
- **kpi-scorer.js**: Applies scoring logic and thresholds to generate KPI scores and grades
- **impact-estimator.js**: Calculates environmental impact (CO2, water, energy) from data transfer

### reporting/
- **report-generator.js**: Generates detailed Markdown reports with recommendations
- **csv-exporter.js**: Handles CSV and JSONL export functionality
- **diff-generator.js**: Compares reports and generates diff summaries

### utils/
- **file-helpers.js**: Common file operations, path utilities, and formatting functions
- **network-helpers.js**: URL parsing, content-type detection, and network-related utilities
- **config-loader.js**: Configuration file loading and parsing

## Compatibility

The modular version maintains full compatibility with the original `greenit-kpi-runner-v3.9.7.js`:
- Same configuration format (`config.yml`)
- Same output structure and file formats
- Same CLI arguments and behavior
- Same KPI calculation logic and thresholds

## Migration

To migrate from the monolithic version:
1. Use `npm run kpi:modular` instead of `npm run kpi`
2. All existing configurations and workflows remain unchanged
3. Output files are generated in the same locations with the same formats

## Development

When adding new features:
1. Identify the appropriate module based on responsibility
2. Add new functions to existing modules or create new modules as needed
3. Update imports in `main.js` if adding new modules
4. Maintain the same interface contracts between modules
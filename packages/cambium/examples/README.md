# Cambium Genesis Package — Demo

## What this demonstrates
- `*.cmb.rb` Ruby DSL authoring
- TypeBox contract (`AnalysisReport`)
- Runner validates output and writes a trace

## Run (planned)
```bash
cambium run packages/cambium/app/gens/analyst.cmb.rb --method analyze --arg packages/cambium/examples/fixtures/incident.txt
```

## Fixtures
- `fixtures/incident.txt` — sample incident transcript input

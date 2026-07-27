# Deterministic mixed-load benchmark

The harness runs 12,000 seeded fake I/O checks (`setTimeout`) without external
services. It reports throughput, peak RSS and heap, event-loop delay, active
handles, and report batch count. Each command performs three runs and prints
median values.

This is useful for scheduler and micro-batch regressions. It is **not** a
substitute for soak tests on real container SKUs with live HTTP/DNS/DB work.

```text
npm run benchmark:legacy
npm run benchmark
```

## Profiles

The default `stress` profile distributes work evenly across network, database,
and diagnostic classes. It intentionally demonstrates that the diagnostic
budget limits expensive work. The representative probe profile uses 90 percent
network, 9 percent database, and 1 percent diagnostic work:

```text
BENCH_PROFILE=typical npm run benchmark:legacy
BENCH_PROFILE=typical npm run benchmark
```

## SKU budgets

Pin concurrency to a published SKU profile:

```text
BENCH_SKU=sku-1c1g npm run benchmark
BENCH_SKU=sku-2c2g npm run benchmark
BENCH_SKU=sku-2c4g npm run benchmark
```

Aliases `1c1g`, `2c2g`, and `2c4g` are accepted. Without `BENCH_SKU`, the
harness uses the 1c/1GB defaults from `constants.js`.

| SKU | total | network | db | diag | batch size |
|-----|------:|--------:|---:|-----:|-----------:|
| sku-1c1g | 16 | 13 | 2 | 1 | 50 |
| sku-2c2g | 28 | 24 | 3 | 1 | 100 |
| sku-2c4g | 40 | 34 | 4 | 2 | 100 |

In PowerShell:

```powershell
$env:BENCH_PROFILE='typical'
$env:BENCH_SKU='sku-2c2g'
npm run benchmark
```

## Container smoke (optional)

To approximate a SKU on Docker Desktop / Linux:

```bash
docker run --rm -it \
  --cpus=1 --memory=1g \
  -e API_URL=https://m0nitor.com/api \
  -e PROBE_TOKEN=your-token \
  -e LOG_LEVEL=info \
  ghcr.io/m0nitor-com/agent:latest
```

Repeat with `--cpus=2 --memory=2g` or `--cpus=2 --memory=4g`. Confirm startup
logs show the matching SKU (`sku-1c1g` / `sku-2c2g` / `sku-2c4g`) and budgets.

The checked-in `results-2026-07-27.json` records an earlier baseline on Node
22.13.1 / Windows x64. Re-run on an idle machine after budget changes.

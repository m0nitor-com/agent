# m0nitor Agent

This is the distributed worker agent for [m0nitor.com](https://m0nitor.com). It performs availability and performance checks from various locations and reports back to the main console.

## Features

- **Protocol Support**: HTTP(S), Ping (ICMP/ICMPv6), TCP, UDP, DNS, SSH reachability, MySQL/MariaDB, PostgreSQL, Redis, MTR and traceroute.
- **Dual-Stack**: IPv4 and IPv6 targets, with an optional per-check or global address-family preference.
- **Secure**: Uses token-based authentication with the m0nitor API.
- **Resource-aware**: Detects cgroup CPU/memory (with host fallback), selects SKU budgets, micro-batches reports, and governs concurrency from RSS / event-loop lag.
- **Containerized**: Ready for Docker and Kubernetes deployments.

## Quick Start

### Option 1: Docker (Recommended)

Run the worker using the pre-built Docker image.

```bash
docker run -d \
  --name m0nitor-agent \
  --restart always \
  --cpus=1 --memory=1g \
  -e API_URL="https://m0nitor.com/api" \
  -e PROBE_TOKEN="your-probe-token-here" \
  ghcr.io/m0nitor-com/agent:latest
```

Use `--cpus` / `--memory` (or Kubernetes resource limits) so the agent sees the
intended SKU via cgroup detection. Examples: `--cpus=2 --memory=2g`,
`--cpus=2 --memory=4g`.

> **Ping (ICMP/ICMPv6) checks**: The image grants its `ping` binary the `NET_RAW`
> capability, which Docker keeps in its default capability set, so ICMP and ICMPv6
> checks work out of the box. If your host or orchestrator drops capabilities (e.g.
> `--cap-drop=ALL`, restrictive Kubernetes `securityContext`), re-add it with
> `--cap-add=NET_RAW`. As an alternative you can pass
> `--sysctl net.ipv4.ping_group_range="0 2147483647"`.

### Option 2: Docker Compose

Create a `docker-compose.yml`:

```yaml
version: '3'
services:
  agent:
    image: ghcr.io/m0nitor-com/agent:latest
    restart: always
    cpus: 1
    mem_limit: 1g
    environment:
      - API_URL=https://m0nitor.com/api
      - PROBE_TOKEN=your-probe-token-here
      - LOG_LEVEL=info
    # Ping (ICMP) works by default. If your environment drops capabilities,
    # uncomment one of the following:
    # cap_add:
    #   - NET_RAW
    # sysctls:
    #   - net.ipv4.ping_group_range=0 2147483647
```

Then run:
```bash
docker-compose up -d
```

### Option 3: Manual Installation (Node.js)

**Prerequisites**: Node.js 22 or newer.

1. **Clone the repository**:
   ```bash
   git clone https://github.com/m0nitor-com/agent.git
   cd agent
   ```

2. **Install dependencies**:
   ```bash
   npm install --production
   ```

3. **Configure**:
   Copy `.env.example` to `.env` and edit it:
   ```bash
   cp .env.example .env
   nano .env
   ```
   Set `API_URL` and `PROBE_TOKEN`.

4. **Start**:
   ```bash
   npm start
   ```

   > Start it through `npm start`, not `node src/index.js`. The script raises
   > Node's response-header limit to 64 KB; on the default 16 KB, sites that ship
   > large `Link` preload headers fail to parse and are reported as unreachable.

## Configuration

All configuration is done via environment variables.

| Variable | Description | Default |
|----------|-------------|---------|
| `API_URL` | The base URL of the m0nitor API | **Required** |
| `PROBE_TOKEN` | The unique authentication token for this agent | **Required** |
| `LOG_LEVEL` | Logging verbosity (`debug`, `info`, `warn`, `error`) | `info` |
| `POLL_INTERVAL`| Time between check cycles in milliseconds | `5000` |
| `POLL_MAX_INTERVAL` | Cap for exponential backoff under consecutive poll failures (ms). Worker rate-limits its API polls when the console is unreachable, capping the delay here. Set equal to `POLL_INTERVAL` to disable backoff. | `300000` |
| `SKIP_SSL_VERIFY` | Skip SSL certificate verification (**INSECURE**) | `false` |
| `ALLOW_PRIVATE_TARGETS` | Global override for the SSRF guard - when `true`, the worker will accept monitor targets that resolve to private/reserved IP ranges (RFC1918, loopback, link-local, IPv6 ULA/link-local, etc.). Intended for self-hosted operators monitoring a trusted LAN. A per-monitor `allow_private_target` flag takes precedence. **Leave `false` unless you trust every monitor target.** | `false` |
| `IP_FAMILY` | Default address family for checks when a monitor does not request one (`auto`, `ipv4`, `ipv6`). `auto` lets the OS choose; a per-monitor family always takes precedence. | `auto` |
| `HEALTH_PORT` | Port for the built-in health-check HTTP server (`/health`). | `8080` |
| `AGENT_SKU` | Force a SKU profile (`sku-1c1g`, `sku-2c2g`, `sku-2c4g`). Empty = auto-detect from cgroup/host. | auto |
| `CONCURRENCY_LIMIT` | Maximum number of active checks across all budgets. | SKU / formula |
| `NETWORK_CONCURRENCY` | Concurrent lightweight network checks. | SKU / formula |
| `DATABASE_CONCURRENCY` | Concurrent database connections. No pools are retained. | SKU / formula |
| `DIAGNOSTIC_CONCURRENCY` | Concurrent MTR or traceroute processes. | SKU / formula |
| `HTTP_MAX_SOCKETS` | Max sockets per shared HTTP check agent (coupled to network budget). | SKU / formula |
| `HTTP_MAX_FREE_SOCKETS` | Max free sockets retained per shared HTTP check agent. | SKU / formula |
| `RESULT_QUEUE_MAX_ENTRIES` | Maximum retry queue entries. Oldest results are dropped with telemetry when full. | SKU / formula |
| `RESULT_QUEUE_MAX_BYTES` | Maximum serialized retry queue size. | SKU / formula |
| `REPORT_BATCH_MAX_SIZE` | Maximum results per micro-batched report request. | SKU / formula |
| `REPORT_BATCH_MAX_BYTES` | Maximum serialized report request size. | SKU / formula |
| `REPORT_COALESCE_IDLE_MS` | Idle flush delay for report micro-batches (ms). | `30` |
| `REPORT_MAX_IN_FLIGHT` | Max concurrent report-batch HTTP requests. | `2` |
| `SOFT_RSS_BYTES` | RSS soft limit - reduces effective concurrency. | SKU / formula |
| `HARD_RSS_BYTES` | RSS hard limit - pauses scheduler, drops oldest queued results, sets `saturated`. | SKU / formula |
| `SHUTDOWN_FLUSH_TIMEOUT` | Maximum graceful result flush time in milliseconds. | `5000` |

### Scale budgets (auto-selected)

The agent prefers named SKUs when cgroup/host resources match; otherwise it uses
`total = clamp(round(8 + 8*cpus + 4*memGiB), 8, 64)` with related network/db/diag
and HTTP socket coupling.

| SKU | total | network | db | diag | HTTP sockets | Queue entries / bytes | Batch size / bytes | Soft RSS | Hard RSS |
|-----|------:|--------:|---:|-----:|-------------:|----------------------:|-------------------:|---------:|---------:|
| 1c/1GB | 16 | 13 | 2 | 1 | 6 | 500 / 4 MiB | 50 / 512 KiB | 350 MiB | 550 MiB |
| 2c/2GB | 28 | 24 | 3 | 1 | 12 | 1000 / 8 MiB | 100 / 1 MiB | 700 MiB | 1.2 GiB |
| 2c/4GB | 40 | 34 | 4 | 2 | 16 | 1500 / 12 MiB | 100 / 1 MiB | 1.5 GiB | 2.8 GiB |

ENV overrides still work, then are normalized so network/db/diag and HTTP sockets
stay within the total budget.

Startup logs include the detected resources and chosen budgets. Health payloads
expose governor state, coalescer telemetry, and `saturated` when hard pressure
trips.

> Response headers are parsed up to 64 KB (`--max-http-header-size`, set in
> the start script and in the image). Node's 16 KB default rejects real-world
> sites outright. Raise it further only if you need to: the limit bounds how
> much a remote server can make this process buffer per response.

> **Security Warnings**:
> - Only set `SKIP_SSL_VERIFY=true` in development environments with self-signed certificates. Never use this in production as it allows man-in-the-middle attacks.
> - `ALLOW_PRIVATE_TARGETS=true` disables SSRF egress protection globally. Use only on isolated worker instances where every operator is trusted to define monitor targets.

## Performance verification

Run `npm run benchmark` for the fair, budgeted runtime and
`npm run benchmark:legacy` for the fixed-chunk comparison. Set
`BENCH_PROFILE=typical` for the representative mix and `BENCH_SKU=sku-2c2g`
(or `sku-1c1g` / `sku-2c4g`) to pin concurrency. The harness uses synthetic
timers only - see `bench/README.md` for honesty notes and optional Docker
`--cpus` / `--memory` smoke commands.

## Deployment / Updates

The agent is designed to be stateless. To update, simply pull the latest Docker image and restart the container.

```bash
docker pull ghcr.io/m0nitor-com/agent:latest
docker stop m0nitor-agent
docker rm m0nitor-agent
# Run again with your original command
```

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

## License

[MIT](LICENSE)

# m0nitor Agent

This is the distributed worker agent for [m0nitor.com](https://m0nitor.com). It performs availability and performance checks from various locations and reports back to the main console.

## Features

- **Protocol Support**: HTTP(S), Ping (ICMP), TCP, UDP, DNS.
- **Secure**: Uses token-based authentication with the m0nitor API.
- **Lightweight**: Optimized Node.js architecture with minimal footprint.
- **Containerized**: Ready for Docker and Kubernetes deployments.

## 🚀 Quick Start

### Option 1: Docker (Recommended)

Run the worker using the pre-built Docker image.

```bash
docker run -d \
  --name m0nitor-agent \
  --restart always \
  -e API_URL="https://m0nitor.com/api" \
  -e PROBE_TOKEN="your-probe-token-here" \
  ghcr.io/m0nitor-com/agent:latest
```

> ℹ️ **Ping (ICMP) checks**: The image grants its `ping` binary the `NET_RAW`
> capability, which Docker keeps in its default capability set, so ICMP checks
> work out of the box. If your host or orchestrator drops capabilities (e.g.
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

**Prerequisites**: Node.js 20 LTS or newer.

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

## 🔧 Configuration

All configuration is done via environment variables.

| Variable | Description | Default |
|----------|-------------|---------|
| `API_URL` | The base URL of the m0nitor API | **Required** |
| `PROBE_TOKEN` | The unique authentication token for this agent | **Required** |
| `LOG_LEVEL` | Logging verbosity (`debug`, `info`, `warn`, `error`) | `info` |
| `POLL_INTERVAL`| Time between check cycles in milliseconds | `5000` |
| `POLL_MAX_INTERVAL` | Cap for exponential backoff under consecutive poll failures (ms). Worker rate-limits its API polls when the console is unreachable, capping the delay here. Set equal to `POLL_INTERVAL` to disable backoff. | `300000` |
| `SKIP_SSL_VERIFY` | Skip SSL certificate verification (**INSECURE**) | `false` |
| `ALLOW_PRIVATE_TARGETS` | Global override for the SSRF guard — when `true`, the worker will accept monitor targets that resolve to private/reserved IP ranges (RFC1918, loopback, link-local, etc.). Intended for self-hosted operators monitoring trusted LAN. Per-monitor opt-in via `monitor.allow_private_target` (Business+ plan-gated on the console) takes precedence. **Leave `false` for SaaS / untrusted environments.** | `false` |

> ⚠️ **Security Warnings**:
> - Only set `SKIP_SSL_VERIFY=true` in development environments with self-signed certificates. Never use this in production as it allows man-in-the-middle attacks.
> - `ALLOW_PRIVATE_TARGETS=true` disables SSRF egress protection globally. Use only on isolated worker instances where every operator is trusted to define monitor targets.

## 📦 Deployment / Updates

The agent is designed to be stateless. To update, simply pull the latest Docker image and restart the container.

```bash
docker pull ghcr.io/m0nitor-com/agent:latest
docker stop m0nitor-agent
docker rm m0nitor-agent
# Run again with your original command
```

## 🤝 Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

## 📄 License

[MIT](LICENSE)

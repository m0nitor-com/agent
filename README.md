# m0nitor Worker

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
  --name m0nitor-worker \
  --restart always \
  -e API_URL="https://console.m0nitor.com/api" \
  -e PROBE_TOKEN="your-probe-token-here" \
  ghcr.io/your-username/m0nitor-worker:latest
```

### Option 2: Docker Compose

Create a `docker-compose.yml`:

```yaml
version: '3'
services:
  worker:
    image: ghcr.io/your-username/m0nitor-worker:latest
    restart: always
    environment:
      - API_URL=https://console.m0nitor.com/api
      - PROBE_TOKEN=your-probe-token-here
      - LOG_LEVEL=info
```

Then run:
```bash
docker-compose up -d
```

### Option 3: Manual Installation (Node.js)

1. **Clone the repository**:
   ```bash
   git clone https://github.com/your-username/m0nitor-worker.git
   cd m0nitor-worker
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
| `PROBE_TOKEN` | The unique authentication token for this worker | **Required** |
| `LOG_LEVEL` | Logging verbosity (`debug`, `info`, `warn`, `error`) | `info` |
| `POLL_INTERVAL`| Time between check cycles in milliseconds | `5000` |
| `SKIP_SSL_VERIFY` | Skip SSL certificate verification (**INSECURE**) | `false` |

> ⚠️ **Security Warning**: Only set `SKIP_SSL_VERIFY=true` in development environments with self-signed certificates. Never use this in production as it allows man-in-the-middle attacks.

## 📦 Deployment / Updates

The worker is designed to be stateless. To update, simply pull the latest Docker image and restart the container.

```bash
docker pull ghcr.io/your-username/m0nitor-worker:latest
docker stop m0nitor-worker
docker rm m0nitor-worker
# Run again with your original command
```

## 🤝 Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

## 📄 License

[MIT](LICENSE)

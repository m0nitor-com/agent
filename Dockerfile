# Use a current Node.js 24 Alpine base for a small footprint (satisfies engines >=22)
FROM node:25-alpine

# Set working directory
WORKDIR /app

# Install a real ping (iputils) and grant it the NET_RAW capability so the
# non-root user can send ICMP. Docker keeps NET_RAW in its default capability
# set, so this works without any runtime --cap-add or --sysctl flag.
RUN apk add --no-cache iputils libcap mtr traceroute \
    && setcap cap_net_raw+ep "$(command -v ping)"

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy source code
COPY src ./src

# Create a non-root user
RUN addgroup -S worker && adduser -S worker -G worker

# Change ownership of the application directory
RUN chown -R worker:worker /app

# Switch to non-root user
USER worker

# Environment variables (defaults)
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV HEALTH_PORT=8080
# Node parses 16 KB of response headers by default and aborts the whole response
# beyond that. Real sites ship more (a single Link preload header can be ~29 KB),
# so the ceiling is raised here as well as in the npm start script, which covers
# entrypoints that bypass npm.
ENV NODE_OPTIONS=--max-http-header-size=65536

# Health check endpoint - uses the same HEALTH_PORT env var as the app
EXPOSE ${HEALTH_PORT}
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:${HEALTH_PORT}/health || exit 1

# Start the agent
CMD ["npm", "start"]

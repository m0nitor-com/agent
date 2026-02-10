# Use Node.js 18 Alpine for a small footprint
FROM node:18-alpine

# Set working directory
WORKDIR /app

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

# Health check endpoint
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8080/health || exit 1

# Start the agent
CMD ["npm", "start"]

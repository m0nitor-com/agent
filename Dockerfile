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

# Start the worker
CMD ["npm", "start"]

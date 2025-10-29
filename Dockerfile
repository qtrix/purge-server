# ------------------------
# Stage 1: Development
# ------------------------
FROM node:18-alpine AS dev

WORKDIR /app

# Install all dependencies (including dev)
COPY package*.json ./
RUN npm ci

# Copy source files
COPY . .

# Expose port
EXPOSE 3001

# Start in development
CMD ["npm", "run", "dev"]

# ------------------------
# Stage 2: Production
# ------------------------
FROM node:18-alpine AS prod

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy TypeScript config & source
COPY tsconfig.json ./
COPY src ./src

# Build the project
RUN npm run build

# Copy built files
COPY --from=prod /app/dist ./dist

# Expose port
EXPOSE 3001

# Health check (optional)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start server
CMD ["npm", "start"]

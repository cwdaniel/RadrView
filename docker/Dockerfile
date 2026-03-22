FROM node:22-slim

# Install GDAL CLI tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    gdal-bin \
    wget \
    ca-certificates \
    python3 \
    g++ \
    make \
    && rm -rf /var/lib/apt/lists/*

# Set GDAL environment
ENV GDAL_DATA=/usr/share/gdal
ENV PROJ_DATA=/usr/share/proj

WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install dependencies
COPY package.json pnpm-lock.yaml ./
COPY .npmrc ./
RUN pnpm install --frozen-lockfile \
    && cd /app/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 \
    && npx --yes node-gyp rebuild

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
COPY palettes/ ./palettes/
COPY public/ ./public/
COPY landing/ ./landing/
RUN pnpm build

CMD ["node", "dist/server/index.js"]

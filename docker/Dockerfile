FROM node:22-slim

# Install GDAL CLI tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    gdal-bin \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set GDAL environment
ENV GDAL_DATA=/usr/share/gdal
ENV PROJ_DATA=/usr/share/proj

WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

CMD ["node", "dist/server/index.js"]

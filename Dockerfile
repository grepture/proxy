FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/
COPY rules.example.json rules.example.json

# Default environment
ENV GREPTURE_MODE=local
ENV PORT=4001

EXPOSE 4001

CMD ["bun", "run", "src/index.ts"]

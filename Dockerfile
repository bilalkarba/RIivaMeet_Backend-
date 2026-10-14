# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: dependencies (full install, including dev deps for build + migrate)
# ---------------------------------------------------------------------------
FROM node:24-slim AS deps
WORKDIR /app

# Prisma 7 does not ship Rust engines, so no OpenSSL/libssl workarounds are needed.
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY tsconfig.json ./

# `postinstall` runs `prisma generate`, which needs the schema above.
RUN npm ci

# ---------------------------------------------------------------------------
# Stage 2: build (TypeScript -> dist)
# ---------------------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3: runtime
# ---------------------------------------------------------------------------
FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0

# Keep dev dependencies in the image on purpose: Northflank runs database
# migrations as a one-off job with the *same* image (`npx prisma migrate deploy`),
# which requires the Prisma CLI. Slim this down with `npm prune --omit=dev` if you
# prefer a smaller image and run migrations from a separate job image.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma.config.ts ./prisma.config.ts

# Run as the non-root user that ships with the node image.
RUN chown -R node:node /app
USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]

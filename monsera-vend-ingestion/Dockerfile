# Build context: this service's folder.
FROM node:22.15.0-slim AS build
WORKDIR /app
RUN apt-get update -qq && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
# postinstall runs `prisma generate` against prisma/schema.prisma (a copy of db/schema.prisma).
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22.15.0-slim
WORKDIR /app
RUN apt-get update -qq && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
USER node
CMD ["node", "dist/main"]

# One-shot migration runner: run it (as a pre-deploy job) before the services
# start. It is the only thing that changes the database schema.
FROM node:22.15.0-slim
WORKDIR /db
RUN apt-get update -qq && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY schema.prisma ./
COPY migrations ./migrations
CMD ["npx", "prisma", "migrate", "deploy", "--schema", "schema.prisma"]

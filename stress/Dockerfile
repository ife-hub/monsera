# The stress test as an App Platform component you open a console on.
# It does nothing until you run the test by hand:
#   node stress-test.mjs
# Settings come from the app's environment (DATABASE_URL, JWT_SECRET,
# BASE_URL, WALLET_*_ID). Remove the component when you are done testing.
FROM node:22.15.0-slim
WORKDIR /stress
RUN apt-get update -qq && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
# postinstall runs `prisma generate`.
RUN npm ci
COPY . .
CMD ["sleep", "infinity"]

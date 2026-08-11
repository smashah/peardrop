FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json .npmrc ./
COPY patches ./patches
COPY packages/core ./packages/core
COPY apps/relay ./apps/relay

RUN npm install --global pnpm@11.20.0 && pnpm install --frozen-lockfile
RUN pnpm --filter @peardrop/core run build
RUN pnpm --filter @peardrop/relay run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY --from=builder /app ./

EXPOSE 8080
CMD ["node", "apps/relay/dist/index.js"]

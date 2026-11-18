# ── Docline web tier (Next.js) ──────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app ./
RUN addgroup -S docline && adduser -S docline -G docline && chown -R docline:docline /app
USER docline
EXPOSE 3000
# Apply the committed, reviewable SQL migrations (drizzle/), then serve.
# Never `push --force` on boot: schema changes ship through reviewed migration
# files, not runtime auto-accepts.
CMD ["sh", "-c", "npx drizzle-kit migrate && npm start"]

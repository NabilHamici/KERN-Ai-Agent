FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
# ignore-scripts: esbuild postinstall is unnecessary because the image builds with tsc only
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
RUN pnpm run build \
  && mkdir -p dist/db \
  && cp -R src/db/migrations dist/db/migrations

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S kern && adduser -S kern -G kern && corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=build /app/dist ./dist
USER kern
EXPOSE 4000
CMD ["node", "dist/server.js"]

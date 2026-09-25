FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@9.15.0
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4100
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 4100
CMD ["node", "dist/apps/api/src/main.js"]

# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
ENV COREPACK_DEFAULT_TO_LATEST=0
WORKDIR /opt/jupyter-collab-mcp
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
RUN --mount=type=cache,target=/root/.cache/node/corepack \
    corepack enable && corepack prepare pnpm@11.11.0 --activate
RUN --mount=type=cache,target=/root/.cache/node/corepack \
    --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY src/ ./src/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm typecheck && pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /opt/jupyter-collab-mcp
COPY --from=build /opt/jupyter-collab-mcp/dist ./dist
COPY --from=build /opt/jupyter-collab-mcp/node_modules ./node_modules
COPY --from=build /opt/jupyter-collab-mcp/package.json ./package.json
RUN groupadd --gid 10001 gateway \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /run/mcp gateway \
    && mkdir -p /run/mcp \
    && chown 10001:10001 /run/mcp \
    && chmod 700 /run/mcp
USER 10001:10001
EXPOSE 8000
ENTRYPOINT ["node", "/opt/jupyter-collab-mcp/dist/mcp/cli.js", "--http"]

FROM runtime AS tested
RUN node /opt/jupyter-collab-mcp/dist/mcp/cli.js --version \
    && node /opt/jupyter-collab-mcp/dist/mcp/cli.js --http --version

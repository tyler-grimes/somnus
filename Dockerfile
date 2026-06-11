# syntax=docker/dockerfile:1
# Somnus agent image. Layout mirrors the repo (/app/agent, /app/brain-mcp)
# because the agent spawns brain-mcp at ../../brain-mcp/dist/index.js
# relative to agent/dist/ (agent/src/agent.ts:33).

FROM node:22-slim AS build
WORKDIR /app
COPY brain-mcp/package.json brain-mcp/package-lock.json brain-mcp/
COPY agent/package.json agent/package-lock.json agent/
RUN cd brain-mcp && npm ci && cd ../agent && npm ci
COPY brain-mcp/ brain-mcp/
COPY agent/ agent/
RUN cd brain-mcp && npm run build && cd ../agent && npm run build

FROM node:22-slim
# Minimal toolset for the agent's Bash tool. The container is the sandbox
# boundary (BASH_AUTO_APPROVE=true); keep the surface small on purpose.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY brain-mcp/package.json brain-mcp/package-lock.json brain-mcp/
COPY agent/package.json agent/package-lock.json agent/
RUN cd brain-mcp && npm ci --omit=dev && cd ../agent && npm ci --omit=dev \
    && npm cache clean --force
COPY --from=build /app/brain-mcp/dist brain-mcp/dist
COPY --from=build /app/agent/dist agent/dist
RUN mkdir -p /app/workspace && chown -R node:node /app/workspace
USER node
WORKDIR /app/agent
CMD ["npm", "run", "start:docker"]

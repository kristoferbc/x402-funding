# syntax=docker/dockerfile:1
#
#   docker build -t x402-funding .
#   docker run -i --rm x402-funding
#
# An MCP client speaks JSON-RPC to the container over stdio, so run it with `-i`
# and keep stdin open.

FROM node:20-alpine AS deps
WORKDIR /app

# package-lock.json is committed, so the install is reproducible and pinned.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# The server logs to stderr on purpose: stdout carries the protocol and must
# stay clean, or the client will fail to parse the stream.
#
# To run the HTTP endpoint instead, override the command:
#   docker run -e PAY_TO=0xYourAddress -e NETWORK=eip155:8453 \
#     -p 4021:4021 x402-funding node src/server.mjs
CMD ["node", "src/mcp-server.mjs"]

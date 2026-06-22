# Deploy relay as a remote MCP App server (Streamable HTTP) on any container
# host — Render, Railway, Fly, Glama, Smithery (container), mcpdeploy,
# mcphosting, etc. relay has ZERO runtime dependencies, so there's nothing to
# install: just copy the source and run the CLI. The platform's injected $PORT
# is honored automatically; set RLY_MCP_TOKEN in the platform's env for a
# bearer-protected endpoint.
FROM node:20-alpine
WORKDIR /app
COPY . .
# Cloud hosts fetch cross-origin, so allow any origin (front it with the host's
# auth, or set RLY_MCP_TOKEN). Override RLY_MCP_ALLOW_ORIGIN to lock it down.
ENV RLY_MCP_ALLOW_ORIGIN=*
EXPOSE 4319
CMD ["node", "bin/rly.js", "mcp", "--http", "--host", "0.0.0.0"]

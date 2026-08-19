FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY networks ./networks
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# Scarlet's versioned prompts are read at runtime from src/prompts/ (identity/activation/conclusion) and
# the per-strategy prompts from src/strategy/ (SCARLET_STRATEGY_DIR). Both are read at runtime, not compiled
# into dist — so BOTH must be copied, or loadPrompt falls back to a generic stub (strategies would be blind).
COPY --from=build /app/src/prompts ./src/prompts
COPY --from=build /app/src/strategy ./src/strategy
# Per-chain network profiles (networks/<chainId>.json) are read at runtime by the config loader.
COPY --from=build /app/networks ./networks
CMD ["node", "--enable-source-maps", "dist/index.js"]

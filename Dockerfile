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
# Scarlet's versioned prompts are read at runtime from src/prompts/ (SCARLET_PROMPT_PATH
# / SCARLET_AGENT_PROMPT_PATH default there); they are not compiled into dist.
COPY --from=build /app/src/prompts ./src/prompts
# Per-chain network profiles (networks/<chainId>.json) are read at runtime by the config loader.
COPY --from=build /app/networks ./networks
CMD ["node", "--enable-source-maps", "dist/index.js"]

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY bot.js db.js ./
# The database lives here; mount a host folder on it so it survives updates.
VOLUME /app/data
CMD ["node", "bot.js"]

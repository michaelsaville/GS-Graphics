FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY app.js config.js db.js csrf.js site-settings.js mailer.js order-status.js square-config.js ./
COPY routes ./routes
COPY views ./views
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /app/public/uploads && chown -R node:node /app/public/uploads

ENV NODE_ENV=production
ENV PORT=3400

USER node
EXPOSE 3400
CMD ["node", "app.js"]

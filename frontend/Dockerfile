FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/pages ./pages
COPY --from=builder /app/styles ./styles
COPY --from=builder /app/next.config.js ./next.config.js
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["npm", "run", "start"]

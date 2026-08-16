FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist ./dist
COPY public ./public

EXPOSE 8080

CMD ["node", "dist/server.js"]
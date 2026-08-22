FROM node:18-alpine

WORKDIR /usr/src/app

# Install dependencies first to leverage Docker cache
COPY package.json package-lock.json* ./
RUN npm ci --only=production || npm install --only=production

# Copy application source
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]

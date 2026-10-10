FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=3000 TRUST_PROXY=1
EXPOSE 3000
USER node
CMD ["node", "server.js"]

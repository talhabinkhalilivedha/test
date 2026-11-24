FROM mcr.microsoft.com/playwright:v1.64.0-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci && npx playwright install chromium

COPY . .
RUN npm run build

ENV HOST=0.0.0.0 \
    PORT=4400 \
    NODE_ENV=production

EXPOSE 4400
CMD ["npm", "start"]


FROM mcr.microsoft.com/playwright:v1.65.1-noble

WORKDIR /app

COPY package.json ./package.json

RUN npm install --omit=dev --no-audit --no-fund

COPY agent.mjs ./agent.mjs

ENV NODE_ENV=production
ENV PROFILE_DIR=/data/profile

CMD ["xvfb-run", "-a", "node", "/app/agent.mjs"]

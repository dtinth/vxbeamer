FROM node:24-slim AS builder

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
RUN npm install -g vite-plus

ENV CI=true
WORKDIR /app
COPY . .
RUN vp install
RUN vp run backend#build

FROM node:24-slim
WORKDIR /app
COPY --from=builder /app/apps/backend/dist/server.mjs ./
COPY --from=builder /app/apps/backend/dist/server.mjs.map ./
EXPOSE 8787
CMD ["node", "--enable-source-maps", "server.mjs"]

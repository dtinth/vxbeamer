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
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=builder /app/apps/backend/dist/server.mjs ./apps/backend/dist/
COPY --from=builder /app/apps/backend/dist/server.mjs.map ./apps/backend/dist/
COPY --from=builder /app/packages/vxasr/package.json ./packages/vxasr/
COPY --from=builder /app/packages/vxasr/dist/ ./packages/vxasr/dist/
COPY --from=builder /app/packages/vxasr/node_modules/ ./packages/vxasr/node_modules/
EXPOSE 8787
CMD ["node", "--enable-source-maps", "apps/backend/dist/server.mjs"]

FROM node:22-slim AS web
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY src ./src
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY backend /app/backend
RUN pip install --no-cache-dir /app/backend
COPY --from=web /build/dist /app/static
ENV SPATIALIZE_STATIC_DIR=/app/static
EXPOSE 8787
CMD ["uvicorn", "spatialize_api.app:app", "--host", "0.0.0.0", "--port", "8787"]

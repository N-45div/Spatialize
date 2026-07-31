FROM node:22-slim AS web
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY src ./src
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
ADD https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx /app/models/kokoro-v1.0.int8.onnx
ADD https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin /app/models/voices-v1.0.bin
COPY backend /app/backend
RUN pip install --no-cache-dir /app/backend
COPY --from=web /build/dist /app/static
ENV SPATIALIZE_STATIC_DIR=/app/static
ENV SPATIALIZE_KOKORO_MODEL_DIR=/app/models
EXPOSE 8787
CMD uvicorn spatialize_api.app:app --host 0.0.0.0 --port ${PORT:-8787}

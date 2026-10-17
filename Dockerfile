# Imagem única para Linux (x86_64 ou arm64): API + site + worker com whisper.cpp.
# O mesmo arquivo serve o `api` e o `worker` do docker-compose; muda só o comando.

FROM debian:bookworm-slim AS whisper
ARG WHISPER_VERSION=v1.9.5
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${WHISPER_VERSION} https://github.com/ggml-org/whisper.cpp /whisper \
 && cmake -S /whisper -B /whisper/build -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF \
 && cmake --build /whisper/build -j --config Release --target whisper-cli

FROM node:24-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates bzip2 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /whisper/build/bin/whisper-cli /usr/local/bin/whisper-cli
# CLI do Claude: só é usado quando não há ANTHROPIC_API_KEY (modo token local).
ARG INSTALL_CLAUDE_CLI=1
RUN if [ "$INSTALL_CLAUDE_CLI" = "1" ]; then npm install -g @anthropic-ai/claude-code && npm cache clean --force; fi
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/src ./src
# A API gera o zip da extensão a partir desta pasta (/api/extension.zip).
COPY extension /app/extension
COPY --from=web /web/dist /app/web/dist
ENV NODE_ENV=production WEB_DIST=/app/web/dist DATA_DIR=/data WHISPER_MODELS_DIR=/models
RUN useradd -m -u 10001 app && mkdir -p /data /models && chown app /data /models
USER app
EXPOSE 3000
CMD ["node", "src/index.ts"]

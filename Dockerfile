# Grain download helper (server/index.mjs) for hosting.
FROM node:20-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server ./server
ENV GRAIN_PUBLIC=1 PORT=8787
EXPOSE 8787
USER node
CMD ["node", "server/index.mjs"]

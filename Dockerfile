FROM oven/bun:1.3-alpine
LABEL org.opencontainers.image.source=https://github.com/christopher-nies/highlights
LABEL org.opencontainers.image.description="Self-hosted highlights store: ingest from Readeck, one highlight a day over HTTP"
WORKDIR /app
COPY package.json schema.sql ./
COPY src ./src
COPY test ./test
USER bun
EXPOSE 8790
CMD ["bun", "src/main.ts"]

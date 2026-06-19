FROM node:24-alpine

WORKDIR /app
COPY . .

RUN --mount=type=secret,id=env_file,target=/app/.env \
    apk update && apk add --no-cache bash curl mc netcat-openbsd \
    && npm install --ignore-scripts \
    && mkdir -p /app/upload \
    && rm -rf /etc/apk/cache

EXPOSE 3000
CMD ["npm", "run", "start", "--", "--port=3000"]

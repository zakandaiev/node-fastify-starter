FROM node:lts-alpine

WORKDIR /app

COPY . .

RUN --mount=type=secret,id=env_file,target=/app/.env \
    apk update && apk add --no-cache bash curl mc netcat-openbsd \
    && npm install --ignore-scripts \
    && rm -rf /etc/apk/cache

CMD ["npm", "run", "start"]

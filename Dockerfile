FROM node:lts-alpine

WORKDIR /app

COPY . .

RUN apk update && apk add --no-cache bash curl mc netcat-openbsd && npm install --ignore-scripts && npm run build && rm -rf /etc/apk/cache

CMD ["npm", "run", "start"]

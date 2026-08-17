FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY --chown=node:node package.json server.js ./

ENV NODE_ENV=production
USER node

EXPOSE 3000
CMD ["node", "server.js"]


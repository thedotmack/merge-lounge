# syntax = docker/dockerfile:1
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim

LABEL fly_launch_runtime="Node.js"
WORKDIR /app
ENV NODE_ENV="production"

COPY package-lock.json package.json ./
RUN npm ci

COPY . .

# State lives on the mounted volume (Fly [[mounts]] destination / Render disk mountPath / Railway volume)
ENV PORT=8080 STATE_DIR=/data
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "server.js"]

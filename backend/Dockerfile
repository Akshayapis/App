FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /var/uapp/builds
ENV UPLOAD_DIR=/var/uapp/builds
EXPOSE 3000
CMD ["node", "server.js"]

FROM node:20

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npx prisma generate
RUN npm run build

CMD ["sh", "-c", "node dist/jobs/processRecurrences.js && node dist/server.js"]
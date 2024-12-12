FROM node:22-alpine

WORKDIR /app

# Copy only package files to install dependencies
COPY package.json ./

# Install dependencies
RUN npm install

# Copy the rest of the code
COPY src ./src
COPY scripts ./scripts
COPY wait-for-services.sh /wait-for-services.sh

RUN chmod +x /wait-for-services.sh

EXPOSE 7777

CMD ["/wait-for-services.sh", "cars-mysql", "3306", "cars-k3s", "6443", "npm", "run", "start:dev"]

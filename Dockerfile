FROM node:22-alpine

WORKDIR /app

# Install kubectl
RUN apk add --no-cache curl bash openssl buildah shadow 0docker-cli
RUN curl -LO "https://dl.k8s.io/release/v1.25.0/bin/linux/amd64/kubectl" && \
    chmod +x kubectl && mv kubectl /usr/local/bin/kubectl

# Install helm
RUN curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Copy only package files to install dependencies
COPY package.json ./

# Install dependencies
RUN npm install

# Copy the rest of the code
COPY src ./src
COPY wait-for-services.sh /wait-for-services.sh

RUN chmod +x /wait-for-services.sh

EXPOSE 7777

CMD ["npm", "run", "start:prod"]

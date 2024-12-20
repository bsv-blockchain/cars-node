# Small Scale CARS Node Deployment Guide

This is a rough guide for how to get up and running with a CARS node from scratch. Not everything here is guaranteed to be fully accurate or work for everyone, but please provide feedback and suggest improvements.

## Overview

We will:

1. **Provision a Linux VPS** (e.g., on DigitalOcean) with one public IP address (e.g., `203.0.113.10`).
   
2. **Set Up System Dependencies**:
   - Install Nginx and Certbot for HTTPS termination.
   - Install MySQL and create a database and user for the CARS Node.
   - Install Docker and Docker Compose.
   - Run the CARS Node setup script and configure environment variables.

3. **Configure DNS**:
   - Purchase a domain, point `cars.example.com` and the wildcard `*.projects.example.com` to the IP address (we'll suppose `203.0.113.10`).

4. **Set Up SendGrid and TAAL**:
   - Sign up for SendGrid, verify domain, obtain API key for emails.
   - Sign up for TAAL, get testnet and mainnet API keys.

5. **Run and Manage the CARS Node**:
   - Start the CARS Node services with Docker Compose.
   - Configure a systemd service for startup.
   - Test by creating a project and a release.
   - Debug and monitor logs and metrics.

6. **Verification and Customization**.

This guide assumes basic familiarity with Linux server administration.

---

## 1. Provisioning the VPS and Setting Up Networking

**Choose a Cloud Provider:**  
You may select a provider such as DigitalOcean, AWS, GCP, or another of your choice.

**Create a Droplet (VPS):**  
- Use Ubuntu 22.04 x64.
- Consider 4GB RAM, 2 vCPU as a minimum (adjust as needed).
- Select a data center region close to you.
- Ensure you have a public IPv4 address, for example, `203.0.113.10`.

**Assign DNS Records:**
- Configure the domain’s DNS records such that:
  - `cars.example.com` → `203.0.113.10`
  - `*.projects.example.com` → `203.0.113.10`
  
After setting these DNS records, wait for propagation. You should be able to `ping cars.example.com` from your local machine once DNS is ready.

**SSH into the Server:**
```bash
ssh root@203.0.113.10
```

Update the system:
```bash
apt update && apt upgrade -y
```

---

## 2. System Setup and Dependencies

### Install Nginx and Certbot

We will use Nginx as a front-end traffic router and SSL terminator for the main CARS Node domain. We’ll also use Certbot to obtain and renew TLS certificates.

```bash
apt install -y nginx certbot python3-certbot-nginx
```

### Configure Firewall

If you use `ufw`:
```bash
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw enable
```

### Domain and Certificate Setup

Buy a domain if you haven’t already, for example `example.com`. For this guide, we assume:
- Primary domain for CARS Node: `cars.example.com`
- Projects deployment domain: `*.projects.example.com`

Obtain an HTTPS certificate for `cars.example.com`:
```bash
certbot --nginx -d cars.example.com
```
Follow the prompts to get a Let’s Encrypt certificate. After completion, Nginx will have a configuration snippet for TLS at `cars.example.com`. You can verify by navigating to `https://cars.example.com` in a browser (though it may show a default page or a 502 error until the CARS Node is running).

### Nginx Reverse Proxy and Routing Setup

You have one IP for all traffic. You must route requests so that:

- Requests to `cars.example.com` are SSL-terminated by Nginx and then proxied to the CARS Node, which will run on an internal port (e.g. `localhost:7777`).
- Requests to `*.projects.example.com` must be forwarded to the Kubernetes ingress inside the CARS Node environment. The Kubernetes ingress will handle its own TLS certificates for project subdomains. Thus, for HTTPS traffic destined for `*.projects.example.com`, Nginx must use TLS passthrough based on SNI, forwarding the raw encrypted data directly to the ingress. For HTTP traffic to `*.projects.example.com`, Nginx should proxy it to the ingress’s HTTP port so that Let’s Encrypt challenges and other HTTP functions work for the project domains.

We will configure Nginx as follows:

- Use Nginx’s `stream` module for port 443 (HTTPS) to route based on SNI:
  - If SNI is `cars.example.com`, route to a local HTTPS termination endpoint at `127.0.0.1:4443`.
  - Otherwise (any other domain, including `*.projects.example.com`), pass through TLS traffic to the Kubernetes ingress at `127.0.0.1:6443`.
- Use Nginx’s `http` configuration for port 80 (HTTP):
  - If `Host` is `cars.example.com`, redirect to HTTPS.
  - If `Host` matches `projects.example.com` or any `*.projects.example.com`, proxy requests to `127.0.0.1:6080` (where the Kubernetes ingress listens for HTTP).

**Edit Nginx Configuration:**

Create a file for stream-based routing (e.g. `/etc/nginx/conf.d/stream.conf`):

```nginx
stream {
    map $ssl_preread_server_name $upstream {
        cars.example.com    127.0.0.1:4443;
        default             127.0.0.1:6443; # Kubernetes ingress TLS endpoint
    }

    server {
        listen 443;
        ssl_preread on;
        proxy_pass $upstream;
    }
}
```

Create a configuration for HTTP routing (e.g. `/etc/nginx/sites-available/cars-and-projects.conf`):

```nginx
server {
    listen 80;
    server_name cars.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 80;
    server_name projects.example.com *.projects.example.com;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_pass http://127.0.0.1:6080;
}
```

Now create a configuration for `cars.example.com` HTTPS termination on a custom port (`4443`), which Nginx’s stream block will forward to:

```nginx
server {
    listen 4443 ssl;
    server_name cars.example.com;

    ssl_certificate /etc/letsencrypt/live/cars.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cars.example.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location / {
        proxy_pass http://127.0.0.1:7777;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable the sites and test the configuration:
```bash
ln -s /etc/nginx/sites-available/cars-and-projects.conf /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

At this point, Nginx will:
- Terminate TLS for `cars.example.com` and forward to the CARS Node (once it’s running).
- Pass through TLS for `*.projects.example.com` to the Kubernetes ingress.
- Route all HTTP requests for `*.projects.example.com` to the ingress for ACME challenges and other HTTP-based needs.

### Install MySQL

For a small scale deployment, a single MySQL instance on the same server is sufficient:

```bash
apt install -y mysql-server
systemctl start mysql
systemctl enable mysql
```

Secure MySQL:
```bash
mysql_secure_installation
```

Create a database and user:
```bash
mysql -u root -p
```
Inside MySQL shell:
```sql
CREATE DATABASE cars_db;
CREATE USER 'cars_user'@'localhost' IDENTIFIED BY 'cars_pass';
GRANT ALL PRIVILEGES ON cars_db.* TO 'cars_user'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

### Install Docker and Docker Compose

```bash
apt install -y ca-certificates curl gnupg lsb-release

mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  gpg --dearmor -o /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
   https://download.docker.com/linux/ubuntu \
   $(lsb_release -cs) stable" | \
   tee /etc/apt/sources.list.d/docker.list > /dev/null

apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

Test Docker:
```bash
docker run hello-world
```

### Clone CARS Node Repo

```bash
apt install -y git nodejs npm
git clone https://github.com/bitcoin-sv/cars-node.git /opt/cars-node
cd /opt/cars-node
npm install
```

---

## 3. Configure the CARS Node

Use the CARS Node setup script to generate environment variables:

```bash
cd /opt/cars-node
npm run setup
```

When prompted, provide the necessary details. Important environment values:

- `CARS_NODE_PORT=7777`
- `CARS_NODE_SERVER_BASEURL=https://cars.example.com`
- `MYSQL_DATABASE=cars_db`
- `MYSQL_USER=cars_user`
- `MYSQL_PASSWORD=cars_pass` (from above)
- `MYSQL_ROOT_PASSWORD` (the one you set)
- `MAINNET_PRIVATE_KEY` and `TESTNET_PRIVATE_KEY`: You’ll need to provide 64-char hex keys. Generate securely or use existing keys. Fund with at least 250,000 satoshis. [Use KeyFunder](https://keyfunder.babbage.systems). If testnet key funding isn't working (for now), just ignore and move on.
- `TAAL_API_KEY_MAIN` and `TAAL_API_KEY_TEST`: Obtain from TAAL (explained in next step).
- `K3S_TOKEN=cars-token` (random token)
- `KUBECONFIG_FILE_PATH=/kubeconfig/kubeconfig.yaml` (will be created by cluster)
- `DOCKER_HOST=tcp://dind:2375` (as per docker-compose)
- `DOCKER_REGISTRY=cars-registry:5000`
- `PROJECT_DEPLOYMENT_DNS_NAME=projects.example.com` (projects will be at frontend.<id>.projects.example.com)
- `PROMETHEUS_URL=https://prometheus.projects.example.com`
- `SENDGRID_API_KEY` (obtain from SendGrid)
- `SYSTEM_FROM_EMAIL=your@verified-domain.com`
- `CERT_ISSUANCE_EMAIL=your@verified-domain.com`

### Obtain TAAL API Keys

Visit [Taal.com](https://taal.com/) to create an account and get API keys:
- **TAAL_API_KEY_MAIN** for mainnet.
- **TAAL_API_KEY_TEST** for testnet.

Paste them into `.env` or the setup script.

### Setup SendGrid

Create a SendGrid account at [https://sendgrid.com/]. Verify your domain (example.com) following SendGrid’s docs. Once verified:
- Get your API Key from SendGrid.
- Put it in `.env` under `SENDGRID_API_KEY`.
- `SYSTEM_FROM_EMAIL` should be a verified email.

---

## 4. Running CARS Node via Docker Compose

We’ll use the provided `docker-compose.yml`. Refer to the source code you've cloned.

- Update the ingress HTTP port from its default value of 8081 to be 6080.
- Update the ingress HTTPS port from its default value of 8082 to be 6443.
- Review the variables and ensure that everything else is consistent with your setup and expectations. 
- Adjust as needed. Make sure the `.env` file generated by the `npm run setup` script is located in the same directory as your Docker Compose file and your source code.

Once satisfied, run:
```bash
docker compose build
docker compose up -d
```

Check logs:
```bash
docker compose logs -f cars-node
```

Wait for the node to become stable. Access `https://cars.example.com/api/v1/public` in your browser. You should see a CARS Node endpoint responding. If successful, your main domain is now served over HTTPS via Nginx, and the node is fully operational.

### Auto-Start on Server Boot

Create a systemd unit file:
```bash
nano /etc/systemd/system/cars-node.service
```

```ini
[Unit]
Description=CARS Node
After=network.target docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=/opt/cars-node
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
systemctl enable cars-node
systemctl start cars-node
```

---

## 5. Test Creating a Project

From your local machine, install CARS CLI (`npm i -g @bsv/cars-cli`) and point a new CARS configuration to `https://cars.example.com`.

1. On your local dev machine within a BRC-102 project (for example, [the Meter repo](https://github.com/p2ppsr/meter)):
   - Create or update `deployment-info.json` using the interactive `cars` editor.
   - Run `cars config add` to add a CARS config pointing to `https://cars.example.com`.

2. Create a project:
   ```bash
   cars project
   ```
   Interactively create a project. It will ask for network, etc. Currently, mainnet is recommended. Generate a project ID.

3. Top up your project balance:
   ```bash
   cars project topup --amount 50000
   ```

### Debugging Tips

- If something fails, check `docker compose logs cars-node`.
- Check MySQL logs if database issues occur: `docker compose logs mysql`.
- Ensure DNS is correct and `cars.example.com` points to the node IP.
- Ensure the wildcard `*.projects.example.com` points to the second IP, the one used for Kubernetes cluster ingest.

---

## 6. Create a Test Release

- On your dev machine, build your project:
  ```bash
  cars build
  ```
  
- Deploy instantly:
  ```bash
  cars release now
  ```
  
This uploads the build artifact, triggering a deployment.

Check `cars project releases` to see new release. Use `cars project logs` and `cars release logs` commands to debug. Also, check `docker logs cars-node` on the server side.

Sometimes, the server side logs have better information.

On success, you should have:
- `frontend.<projectid>.projects.example.com`
- `backend.<projectid>.projects.example.com`

They should show your application or endpoints.  
If using custom domains, set TXT records and run domain verification from CLI as described in the [CARS CLI README](https://github.com/bitcoin-sv/cars-cli). Set the custom domain's A record to cluster ingress IP.

### Additional Debugging

- `kubectl` inside `k3s` container:  
  ```bash
  docker exec -it cars-k3s kubectl get pods -A
  ```
- Check ingress:  
  ```bash
  docker exec -it cars-k3s kubectl get ingresses -A
  ```

---

## 7. Verify Everything is Working

- Ensure that `https://cars.example.com/api/v1/public` is online and reporting good data.
- `cars project info` shows correct project info.
- `cars project logs` show logs.
- Visit the project’s frontend and backend URLs in a browser.

If SSL certificates for projects are required, CARS Node will annotate ingresses and cert-manager will obtain them. Ensure DNS is correct and Let’s Encrypt cluster issuer is set.

---

## 8. Customization and Monitoring

- **Pricing:** Edit environment variables in `.env` for CPU, MEM, DISK, NET rates and `docker compose up -d`.
- **Prometheus/Grafana:** You can integrate external Prometheus/Grafana to monitor resource usage and get deeper insights.
- **Scaling Up:** For more load, increase VPS size or run MySQL and registry externally. Point `KUBECONFIG_FILE_PATH` to a remote Kubernetes cluster. Modify Helm charts for replication and horizontal pod autoscalers.

---

## 9. Maintenance and Upgrades

To update the CARS Node:
- Pull new changes: `git pull`
- Reinstall dependencies if needed: `npm install`
- Rebuild and redeploy: `docker compose build && docker compose up -d`

Monitor logs and ensure everything restarts cleanly.

---

## Conclusion

You’ve now deployed CARS Node in a small-scale environment with:
- A VPS running Nginx as a reverse proxy with TLS via Let’s Encrypt.
- Local MySQL database.
- K3s-based Kubernetes cluster inside Docker for your projects.
- Docker Compose orchestrating all services.
- Domain and DNS properly configured.
- Billing, TAAL keys, SendGrid for emails, all integrated.

You can now create, deploy, and manage BSV Overlay Services using the CARS CLI against your CARS Node instance, verifying deployments, managing custom domains, tracking logs, and leveraging the cloud-native environment at a small scale.

For future enhancements, consider external load balancers, larger clusters, separate persistence layers, and advanced monitoring for a production-grade environment.

# Small Scale CARS Node Deployment Guide

This is a rough guide for how to get up and running with a CARS node from scratch. Not everything here is guaranteed to be fully accurate or work for everyone, but please provide feedback and suggest improvements.

## Overview

We will:

1. **Provision a Linux VPS** (e.g., on DigitalOcean) with two public IP addresses:
   - **IP #1**: For the CARS Node’s API (e.g., `203.0.113.10`)
   - **IP #2**: For the Kubernetes cluster ingress (e.g., `203.0.113.11`)

2. **Set Up System Dependencies**:
   - Install Nginx, Certbot for HTTPS termination to the CARS Node.
   - Install MySQL and create a database and user for CARS Node.
   - Install Docker and Docker Compose.
   - Create a `.env` file and run `npm run setup` for CARS Node configuration.

3. **Configure DNS**:
   - Purchase a domain, point `cars.example.com` to the Node IP and the wildcard `*.example.com` to the cluster ingress IP.
   
4. **Set Up SendGrid and TAAL**:
   - Sign up for SendGrid, verify domain, obtain API key for emails.
   - Sign up for TAAL, get testnet and mainnet API keys.

5. **Run and Manage CARS Node**:
   - Start CARS Node with `docker-compose`.
   - Configure systemd service to run on startup.
   - Test by creating a project and a release.
   - Debug and monitor system logs and metrics.

6. **Verification and Customization**.

This guide assumes a basic familiarity with Linux server administration.

---

## 1. Provisioning the VPS and Setting Up Networking

**Choose a Cloud Provider:**  
For this guide, let’s pick DigitalOcean, but AWS, GCP, or another provider will work similarly.

**Create a Droplet (VPS):**  
- Sign in to [DigitalOcean](https://www.digitalocean.com/).
- Create a new Droplet:
  - Ubuntu 22.04 x64.
  - 4GB RAM, 2 vCPU (minimum; you can scale up as needed).
  - Choose a data center region close to you.

**Add Floating IPs or Additional IPs:**  
We need two public IP addresses. Assign one IP to the primary interface and request an additional IP (Floating IP or secondary IP) from your provider.  
- IP #1 (Primary): `203.0.113.10` (for CARS Node directly via Nginx)
- IP #2 (Secondary): `203.0.113.11` (for Kubernetes ingress; this will be used by projects)

Make sure these IPs are assigned to your droplet and are reachable by ping.

**SSH into the Server:**
```bash
ssh root@203.0.113.10
```

Update system:
```bash
apt update && apt upgrade -y
```

---

## 2. System Setup and Dependencies

### Install Nginx and Certbot

We will set up Nginx as a reverse proxy in front of the CARS Node, and Certbot for Let’s Encrypt TLS certificates.

```bash
apt install -y nginx certbot python3-certbot-nginx
```

### Configure Firewall

If using ufw:
```bash
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw enable
```

### Domain Setup

Buy a domain from your preferred registrar (e.g. Namecheap, GoDaddy). Let’s assume `example.com`.

- Set `cars.example.com` A-record to `203.0.113.10` (Node IP).
- Set `*.projects.example.com` A-record to `203.0.113.11` (Cluster Ingress IP).

We will later use `PROJECT_DEPLOYMENT_DNS_NAME=projects.example.com` and rely on `frontend.<projectid>.projects.example.com` and `backend.<projectid>.projects.example.com` subdomains pointing to `203.0.113.11`.

### Obtain TLS Certificate for CARS Node

Wait until DNS has propagated (you can `ping cars.example.com` from your local machine to confirm).

Then:
```bash
certbot --nginx -d cars.example.com
```
Follow prompts to get Let’s Encrypt certificate.

This sets up an SSL configuration in Nginx.

Verify your SSL is enabled on `https://cars.example.com`.

### Nginx Reverse Proxy Setup

Create an Nginx config for CARS Node (which will run on port 7777 internally):

```bash
nano /etc/nginx/sites-available/cars-node.conf
```

Add:
```nginx
server {
    listen 80;
    server_name cars.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name cars.example.com;

    ssl_certificate /etc/letsencrypt/live/cars.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cars.example.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location / {
        proxy_pass http://localhost:7777;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable the config:
```bash
ln -s /etc/nginx/sites-available/cars-node.conf /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

After the configuration changes, verify once more to ensure that your SSL is still enabled on `https://cars.example.com`. HTTPS should still work even if there is a 502 error until after CARS node is running on `localhost:7777`.

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

Create DB and user:
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
  "deb [arch=$(dpkg --print-architecture) \
   signed-by=/etc/apt/keyrings/docker.gpg] \
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

## 3. Configure CARS Node

Set environment variables in `.env`. We will run the setup script which interactively generates `.env`:

```bash
cd /opt/cars-node
npm run setup
```

**Key Values to Provide:**
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

- Update the ingress HTTP port from its default value of 8081 to be 80.
- Update the ingress HTTPS port from its default value of 8082 to be 443.
- Review the variables and ensure that everything else is consistent with your setup and expectations. 
- Adjust as needed. Make sure the `.env` file generated by the `npm run setup` script is located in the same directory as your Docker Compose file and your source code.

Run your new CARS node:
```bash
docker compose build
docker compose up -d
```

Check logs:
```bash
docker compose logs -f cars-node
```

Once stable, CARS Node should be accessible at `https://cars.example.com`.

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

- Pull new code and `npm install` for updates.
- `docker compose build` then `docker compose up -d` to apply updates.

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

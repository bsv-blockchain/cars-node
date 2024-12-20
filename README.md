# CARS Node — Cloud Automated Runtime System

**CARS Node** is the backend runtime system for deploying and managing BSV Blockchain-based Overlay Services at scale in a cloud environment. It orchestrates Kubernetes clusters, billing, domain setup, SSL issuance, and application lifecycle management for your projects. Together with the **CARS CLI** and the **LARS** (Local Automated Runtime System) toolkit, CARS Node provides a seamless path from local development to production cloud deployment.

If you’re familiar with the **[CARS CLI](https://github.com/bitcoin-sv/cars-cli)**, which developers use to build and deploy artifacts from their machines, then think of the **CARS Node** as its cloud counterpart—a dynamic environment that receives your deployments, provisions infrastructure, handles scaling, billing, and secure access to your running BSV Overlay Services.

**Deploy Me!** After you check out this README, head on over to [GETTING_STARTED.md](./GETTING_STARTED.md) to follow along for a complete, zero-to-hero deployment exercise!

## Table of Contents

1. [What is CARS Node?](#what-is-cars-node)
2. [Key Features and Responsibilities](#key-features-and-responsibilities)
3. [System Architecture](#system-architecture)
4. [Prerequisites](#prerequisites)
5. [Setup and Configuration](#setup-and-configuration)
   - [Step 1: Environment Variables & .env Setup](#step-1-environment-variables--env-setup)
   - [Step 2: Database and Kubernetes Cluster](#step-2-database-and-kubernetes-cluster)
   - [Step 3: Running CARS Node (Small Scale with Docker Compose)](#step-3-running-cars-node-small-scale-with-docker-compose)
   - [Step 4: Production Considerations](#step-4-production-considerations)
6. [How CARS Node Works](#how-cars-node-works)
   - [Projects and Deployments](#projects-and-deployments)
   - [Billing and Resource Tracking](#billing-and-resource-tracking)
   - [Domains and SSL Certificates](#domains-and-ssl-certificates)
   - [Logs and Debugging](#logs-and-debugging)
   - [Scaling and Load Balancing](#scaling-and-load-balancing)
7. [Integration with the CARS CLI](#integration-with-the-cars-cli)
8. [Admin and Developer Guides](#admin-and-developer-guides)
   - [Admin Tasks (Projects, Admins, Billing)](#admin-tasks-projects-admins-billing)
   - [Release Management and Artifact Deployments](#release-management-and-artifact-deployments)
   - [Adjusting Pricing and Billing Policies](#adjusting-pricing-and-billing-policies)
   - [Observability: Prometheus and Monitoring](#observability-prometheus-and-monitoring)
   - [Automation and CI/CD Integration](#automation-and-cicd-integration)
9. [Security Considerations](#security-considerations)
10. [Tips and Best Practices](#tips-and-best-practices)
11. [License](#license)

---

## What is CARS Node?

CARS Node is the “cloud runtime” counterpart to LARS (Local Automated Runtime System). While LARS helps you develop your BSV Overlay Services locally, CARS Node runs them in a Kubernetes-based cloud environment. It’s responsible for:

- Receiving deployment artifacts built with the CARS CLI.
- Provisioning Kubernetes resources (deployments, services, ingress) on-the-fly.
- Managing domain names, SSL certificates, and secure endpoints.
- Tracking resource usage and billing customers accordingly.
- Providing logs, visibility, and lifecycle management for your BSV Overlay Services.

In short, CARS Node takes your `deployment-info.json` and packaged artifacts and turns them into running, fully managed, and billed cloud services.

---

## Key Features and Responsibilities

- **Automated Kubernetes Provisioning:** CARS Node interacts with a Kubernetes cluster to schedule workloads, manage pods and services, and ensure high availability.
- **Dynamic Ingress and SSL:** Uses `ingress-nginx`, `cert-manager`, and Let’s Encrypt to automatically provision custom domains and HTTPS certificates.
- **Billing and Resource Usage Tracking:** Integrates with Prometheus to gather CPU, memory, disk, and network usage over time, billing projects automatically.
- **Multiple Environment Support:** Supports mainnet and testnet keys, separate private keys, and network-specific TAAL API keys for transaction broadcast, merkle proof acquisition, and double spend detection.
- **Identity and Project Management:** Integrates with the standard BSV identity system, ensuring only authorized admins can create or manage projects.
- **Logging and Observability:** Centralized logs in MySQL, plus direct access to cluster-level logs (frontend/backend/mongo/mysql) via `kubectl` and API endpoints.
- **Extensible Setup:** Designed for both small-scale Docker Compose-based setups and large-scale, production-grade environments.

---

## System Architecture

At a high level, CARS Node is an Express.js server that:

- Connects to a MySQL database to store project metadata, deployments, logs, and accounting records.
- Uses Kubernetes (k3s or a full upstream cluster) to run workloads.
- Integrates with `prometheus`-based monitoring for billing and metrics.
- Uses `helm` to manage deployments and `cert-manager` for SSL certificates.
- Stores artifacts locally before building Docker images and pushing them to a registry.
- Issues new releases by applying Helm charts dynamically constructed at runtime.

---

## Prerequisites

- **BSV Project Structure:** Your deployed projects follow [a known structure (BRC-102)](https://github.com/bitcoin-sv/BRCs/blob/master/apps/0102.md) with `deployment-info.json`, a `backend/`, `frontend/`, and integrated sCrypt contracts (optional).
- **[CARS CLI](https://github.com/bitcoin-sv/cars-cli) Installed Locally (for developer workflows):** Use it on your dev machine to upload built artifacts.
- **Docker & Docker Registry:** Needed for building/pushing images. Use the integrated `registry` and `dind` in the local `docker-compose.yml`, or configure externally.
- **Kubernetes Cluster and kubectl Access:** CARS Node expects access to a k3s or Kubernetes cluster. Again, you can use the pre-configured Rancher k3s in the Compose file, or configure your own for larger scale. The Dockerfile bundled with the code installs `kubectl`, or you can run CARS directly on machine(s) that already have it.
- **Helm:** For deploying workloads as Helm releases. Again, present in the integrated `Dockerfile`, or you can install it yourself.
- **MySQL Database:** Persistent storage of project state. Use the integrated Compose file, or configure your own with ENV variables.
- **SendGrid API Key:** For sending email notifications about billing, deployments, and admin changes. Provide it as an environmental variable or add it to a local `.env` for use with Compose.

---

## Setup and Configuration

### Step 1: Environment Variables & .env Setup

CARS Node is configured via a `.env` file. Run:
```bash
npm run setup
```
This interactive script asks for all required environment variables, including `CARS_NODE_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MAINNET_PRIVATE_KEY`, `TESTNET_PRIVATE_KEY`, `TAAL_API_KEY_MAIN`, `TAAL_API_KEY_TEST`, `K3S_TOKEN`, `DOCKER_HOST`, `DOCKER_REGISTRY`, `PROJECT_DEPLOYMENT_DNS_NAME`, `SENDGRID_API_KEY`, and more.

These variables control your server base URL, database credentials, private keys for blockchain operations, Docker registry configurations, and more. An example `.env` is provided for reference.

### Step 2: Database and Kubernetes Cluster

- **Database (MySQL):** Set up a MySQL 8.0 instance. Provide credentials in `.env`.
- **Kubernetes Cluster:** CARS Node needs a cluster. For local testing, you can run `rancher/k3s` inside Docker Compose. In production, you might connect to an existing cluster via a KUBECONFIG file.

### Step 3: Running CARS Node (Small Scale with Docker Compose)

For development or small-scale demos:

1. Ensure Docker and Docker Compose installed.
2. Run `docker-compose up` from the provided `docker-compose.yml`.  
   This sets up:
   - `cars-mysql` (MySQL database)
   - `cars-k3s` (K3s Kubernetes server)
   - `cars-registry` (local Docker registry)
   - `cars-dind` (Docker-in-Docker for building images)
   - `cars-node` (The CARS Node itself)

Once running, CARS Node listens on `CARS_NODE_PORT` (default: 7777). You can now deploy projects using the CARS CLI from your development machine.

### Step 4: Production Considerations

For larger scale or production:

- **External Kubernetes:** Point `KUBECONFIG_FILE_PATH` to a production kubeconfig.
- **External Registry:** Use a secure Docker registry, configure `DOCKER_REGISTRY`.
- **Custom Domains & SSL:** Ensure that `PROJECT_DEPLOYMENT_DNS_NAME` is a domain you control. CARS Node uses Let’s Encrypt via `cert-manager`.
- **Prometheus & Observability:** Make sure your Prometheus endpoint is stable and reachable.
- **High Availability:** Scale MySQL externally, run multiple CARS Node instances behind a load balancer, ensure persistent volumes for registry, etc.

---

## How CARS Node Works

### Projects and Deployments

- **Projects:** Each BSV Overlay Services deployment managed by CARS Node is a “project.” A project has admins, a unique UUID, a private key, and a balance.
- **Deployments (Releases):** Each time you run `cars release now` or create a release manually, you upload an artifact (tarball) to CARS Node. It extracts the artifact, builds Docker images (backend and/or frontend), and then deploys them to Kubernetes using Helm.

### Billing and Resource Tracking

CARS Node periodically queries Prometheus for CPU, memory, disk, and network usage of each project’s namespace. It calculates costs based on configured rates and debits the project’s balance. Projects must maintain a positive balance to ensure uninterrupted service. Thresholds trigger email alerts as balances drop.

### Domains and SSL Certificates

CARS Node uses Kubernetes ingress with `ingress-nginx` and `cert-manager`:

- Each project gets subdomains of `PROJECT_DEPLOYMENT_DNS_NAME` by default:  
  `frontend.<project-id>.<project-deployment-dns>`,  
  `backend.<project-id>.<project-deployment-dns>`.
- You can also set custom domains by adding TXT verification records. Once verified, CARS Node updates ingress and triggers SSL certificate issuance. Be sure to point any custom domains to the cluster's ingress IP for reachability.
- Let’s Encrypt SSL certificates are managed automatically.

### Logs and Debugging

- **Project Logs:** Stored in MySQL’s `logs` table. View them via API or CARS CLI.
- **Release (Deployment) Logs:** Logs related to a specific deployment stored similarly.
- **Resource-Level Logs:** Direct from `kubectl logs`. CARS Node provides endpoints to fetch logs for `frontend`, `backend`, `mongo`, `mysql` pods.  
- **Global Info and Metrics:** Query `cars global-info` to see public keys and pricing.

### Scaling and Load Balancing

By default, CARS Node runs a single replica of backend/frontend services. For greater scale, you can customize Helm templates to increase replicas. In production, you’ll run CARS Node in a stable environment, possibly with Horizontal Pod Autoscalers and more complex ingress rules.

---

## Integration with the CARS CLI

The CARS CLI is the frontend to CARS Node. Developers run `cars` locally to:

- **Build Artifacts:** `cars build`
- **Create Releases:** `cars release get-upload-url`
- **Upload Artifacts:** `cars release upload-files`
- **Configure Domains and Admins:** `cars project domain:frontend`, `cars project add-admin`

The CLI talks to CARS Node’s APIs. Everything you can do interactively (`cars` with no args) you can also do non-interactively with subcommands.

---

## Admin and Developer Guides

**[Deploy your CARS node now!](./GETTING_STARTED.md)**

### Admin Tasks (Projects, Admins, Billing)

- **Create a Project:** The CLI or direct API calls can create a project. Projects start with one admin.
- **Add/Remove Admins:** Add project admins by identity key or email. Admins can manage billing, deployments, and domains.
- **Top Up Balance:** Use `cars project topup` or the API to add funds in satoshis.

### Release Management and Artifact Deployments

- **Upload Artifacts:** Once you run `cars build`, you get a `.tgz` artifact. `cars release now` or `cars release upload-files` sends this artifact to CARS Node.
- **Deploying to Kubernetes:** CARS Node handles the Kubernetes deployments automatically, running `helm upgrade --install` behind the scenes.

### Adjusting Pricing and Billing Policies

Set rates for CPU, memory, disk, network usage in `.env`. CARS Node reads these and applies them to calculate periodic charges.

### Observability: Prometheus and Monitoring

- **Prometheus Setup:** CARS Node expects a working Prometheus endpoint.  
- **Logs and Metrics:** You can add additional dashboards or integrate with Grafana for advanced observability.

### Automation and CI/CD Integration

Integrate `cars build` and `cars release now` into CI pipelines. After pushing code, CI can run these commands to automatically deploy new versions to CARS Node.

---

## Security Considerations

- **Private Keys:** Keep `MAINNET_PRIVATE_KEY` and `TESTNET_PRIVATE_KEY` secure. These keys are used for blockchain operations.
- **Admin Access:** Only authenticated, registered identities can manage projects. Carefully control who can become a project admin.
- **HTTPS and Domain Verification:** Let’s Encrypt automation ensures end-to-end encryption for public endpoints.

---

## Tips and Best Practices

- **Start Small, Scale Later:** Begin with a local `docker-compose up` environment, then move to production clusters as you grow.
- **Regular Billing Checks:** Watch your project balances. Negative balances may lead to restricted ingress (in production scenarios). Emails are sent to project admins when balances get low.
- **Use Multiple CARS Configs:** In `deployment-info.json`, define multiple CARS configs for staging, production, or different cloud providers.
- **Continuous Deployment:** Combine `cars build` and `cars release now` in CI/CD to achieve fully automated deployment pipelines.

---

## License

CARS Node is licensed under the open BSV license. See [LICENSE.txt](./LICENSE.txt) for more details.

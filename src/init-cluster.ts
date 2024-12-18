import { execSync } from 'child_process';
import logger from './logger';

export async function initCluster() {
    logger.info('Checking if cluster is ready...');
    for (let i = 0; i < 30; i++) {
        try {
            const output = execSync('kubectl get nodes', { encoding: 'utf-8' });
            if (output.includes('Ready')) {
                logger.info('Cluster is ready!');
                break;
            }
        } catch (e) {
            logger.warn('Cluster not ready yet, waiting...');
        }
        await new Promise(r => setTimeout(r, 5000));
    }

    // Remove any existing Traefik ingress controller if present (common in k3s)
    try {
        logger.info('Ensuring no other ingress controllers (like Traefik) exist...');
        // If k3s default traefik HelmChart exists, remove it:
        // This is often how k3s manages traefik: as a HelmChart resource in kube-system
        execSync('kubectl delete helmchart traefik -n kube-system --ignore-not-found=true', { stdio: 'inherit' });

        // Delete any traefik deployments/services just in case:
        execSync('kubectl delete deployment traefik -n kube-system --ignore-not-found=true', { stdio: 'inherit' });
        execSync('kubectl delete svc traefik -n kube-system --ignore-not-found=true', { stdio: 'inherit' });

        // Remove traefik ingressclasses if any
        execSync('kubectl delete ingressclass traefik --ignore-not-found=true', { stdio: 'inherit' });
        execSync('kubectl delete ingressclass traefik-ingress-class --ignore-not-found=true', { stdio: 'inherit' });

        // Remove any other non-nginx ingresscontrollers (if known)
        // For example, if there's another known ingress class, remove it similarly:
        // execSync('kubectl delete ingressclass some-other-ingress --ignore-not-found=true', { stdio: 'inherit' });

        logger.info('All non-nginx ingress controllers removed or not found.');
    } catch (e) {
        logger.error(e, 'Failed to remove other ingress controllers');
    }

    // Install ingress-nginx and make it the default ingress class
    // Setting `--set controller.ingressClassResource.default=true` ensures this ingress is the default.
    try {
        execSync('helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx', { stdio: 'inherit' });
        execSync('helm repo update', { stdio: 'inherit' });
        execSync('helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx --create-namespace -n ingress-nginx --set controller.ingressClassResource.default=true', { stdio: 'inherit' });
        logger.info('Ingress-nginx installed or updated, set as default.');
    } catch (e) {
        logger.error(e, 'Failed to install or set ingress-nginx as default');
    }

    // Create a global namespace for CARS if needed
    try {
        execSync('kubectl create namespace cars-global || true', { stdio: 'inherit' });
        logger.info('cars-global namespace ensured.');
    } catch (e) {
        logger.error(e, 'Failed to ensure cars-global namespace');
    }

    // Install cert-manager
    try {
        execSync('helm repo add jetstack https://charts.jetstack.io', { stdio: 'inherit' });
        execSync('helm repo update', { stdio: 'inherit' });
        execSync('helm upgrade --install cert-manager jetstack/cert-manager --namespace cert-manager --create-namespace --set installCRDs=true', { stdio: 'inherit' });
        logger.info('cert-manager installed.');
    } catch (e) {
        logger.error(e, 'Failed to install cert-manager');
    }

    // Create a ClusterIssuer for Let's Encrypt
    // In production, use the production server. For testing, you may use the staging server.
    const clusterIssuer = `
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-production
spec:
  acme:
    email: "${process.env.CERT_ISSUANCE_EMAIL}"
    server: "https://acme-v02.api.letsencrypt.org/directory"
    privateKeySecretRef:
      name: letsencrypt-production
    solvers:
      - http01:
          ingress:
            class: nginx
`;
    try {
        execSync('kubectl apply -f -', {
            input: clusterIssuer,
            stdio: ['pipe', 'inherit', 'inherit']
        });
        logger.info('ClusterIssuer letsencrypt-production created.');
    } catch (e) {
        logger.error(e, 'Failed to create ClusterIssuer for Let\'s Encrypt');
    }

    // Install kube-prometheus-stack for metrics and monitoring
    try {
        execSync('helm repo add prometheus-community https://prometheus-community.github.io/helm-charts', { stdio: 'inherit' });
        execSync('helm repo update', { stdio: 'inherit' });
        // Values can be customized if needed. We'll rely on defaults that scrape all namespaces.
        execSync(`
          helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
          --create-namespace -n monitoring \
          --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false \
          --set prometheus.prometheusSpec.podMonitorSelectorNilUsesHelmValues=false \
          --set global.scrape_interval=30s \
          --set global.scrape_timeout=10s
        `, { stdio: 'inherit' });

        logger.info('kube-prometheus-stack installed. Prometheus now scrapes the cluster metrics.');
    } catch (e) {
        logger.error(e, 'Failed to install kube-prometheus-stack');
    }
}

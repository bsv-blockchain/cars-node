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

    // Install ingress-nginx if not installed
    try {
        execSync('helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx', { stdio: 'inherit' });
        execSync('helm repo update', { stdio: 'inherit' });
        // Try to install or upgrade ingress-nginx in a dedicated namespace
        execSync('helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx --create-namespace -n ingress-nginx', { stdio: 'inherit' });
        logger.info('Ingress-nginx installed or updated.');
    } catch (e) {
        logger.error(e, 'Failed to install ingress-nginx');
    }

    // Create a global namespace for CARS if needed
    try {
        execSync('kubectl create namespace cars-global || true', { stdio: 'inherit' });
        logger.info('cars-global namespace ensured.');
    } catch (e) {
        logger.error(e, 'Failed to ensure cars-global namespace');
    }
}

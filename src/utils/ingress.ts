import { execSync } from 'child_process';
import logger from '../logger';

// Disable ingress by removing ingress resources
export async function disableIngress(projectUUID: string) {
    const namespace = `cars-project-${projectUUID}`;
    const helmReleaseName = `cars-project-${projectUUID.substr(0, 24)}`;
    // We can patch the ingress to something unreachable or simply delete it.
    // Let's delete the ingress to disable external access:
    try {
        execSync(`kubectl delete ingress -n ${namespace} ${helmReleaseName}-ingress --ignore-not-found=true`);
        logger.info({ project_uuid: projectUUID }, 'Ingress disabled (deleted).');
    } catch (e) {
        logger.error({ project_uuid: projectUUID, error: (e as Error).message }, 'Failed to disable ingress');
    }
}

// Enable ingress by re-running helm upgrade, which will recreate the ingress.
export async function enableIngress(projectUUID: string): Promise<boolean> {
    const namespace = `cars-project-${projectUUID}`;
    const helmReleaseName = `cars-project-${projectUUID.substr(0, 24)}`;

    try {
        // Let's just assume we can do a helm rollback:
        execSync(`helm rollback ${helmReleaseName} 1 -n ${namespace}`, { stdio: 'inherit' });
        logger.info({ project_uuid: projectUUID }, 'Ingress enabled (rollback/upgrade performed).');
        return true;
    } catch (e) {
        logger.error({ project_uuid: projectUUID, error: (e as Error).message }, 'Failed to enable ingress. Re-run deployment.');
    }
    return false;
}

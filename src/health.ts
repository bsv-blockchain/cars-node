import { execSync } from 'child_process';
import axios from 'axios';
import type { Knex } from 'knex';

type HealthStatus = 'ok' | 'degraded' | 'error';

interface HealthCheckResult {
    name: string;
    status: HealthStatus;
    critical: boolean;
    message?: string;
    details?: any;
    durationMs: number;
}

interface HealthCheckDefinition {
    name: string;
    critical?: boolean;
    handler: () => Promise<{ status?: HealthStatus; message?: string; details?: any } | void> | { status?: HealthStatus; message?: string; details?: any } | void;
}

function namespaceForProject(projectId: string) {
    return `cars-project-${projectId}`;
}

function releaseNameForProject(projectId: string) {
    return `cars-project-${projectId.substring(0, 24)}`;
}

function parseJsonCommand(command: string) {
    return JSON.parse(execSync(command, { encoding: 'utf8' }));
}

async function runHealthCheck(definition: HealthCheckDefinition): Promise<HealthCheckResult> {
    const startedAt = Date.now();
    try {
        const result = (await Promise.resolve(definition.handler())) || {};
        return {
            name: definition.name,
            status: result.status || 'ok',
            critical: definition.critical !== false,
            message: result.message,
            details: result.details,
            durationMs: Date.now() - startedAt
        };
    } catch (error: any) {
        return {
            name: definition.name,
            status: 'error',
            critical: definition.critical !== false,
            message: error?.message || 'Unexpected health-check error',
            durationMs: Date.now() - startedAt
        };
    }
}

function summarizeHealth(checks: HealthCheckResult[]): HealthStatus {
    if (checks.some(check => check.critical && check.status === 'error')) {
        return 'error';
    }
    if (checks.some(check => check.status !== 'ok')) {
        return 'degraded';
    }
    return 'ok';
}

function podReady(pod: any) {
    return pod?.status?.phase === 'Running' && Boolean(
        pod?.status?.containerStatuses?.length &&
        pod.status.containerStatuses.every((container: any) => container.ready)
    );
}

async function fetchHttpHealth(url: string) {
    const startedAt = Date.now();
    try {
        const response = await axios.get(url, {
            timeout: 5000,
            validateStatus: () => true
        });
        return {
            status: response.status >= 200 && response.status < 400 && response.data?.status === 'ok' ? 'ok' : 'error',
            message: response.status >= 200 && response.status < 400 ? undefined : `HTTP ${response.status}`,
            details: {
                statusCode: response.status,
                response: response.data
            },
            durationMs: Date.now() - startedAt
        };
    } catch (error: any) {
        return {
            status: 'error',
            message: error?.message || 'HTTP health probe failed',
            durationMs: Date.now() - startedAt
        };
    }
}

export async function collectSystemHealth(db: Knex, options: {
    mainnetWalletReady: boolean;
    testnetWalletReady: boolean;
    migrationsComplete: boolean;
}) {
    const checks = await Promise.all([
        runHealthCheck({
            name: 'database',
            handler: async () => {
                await db.raw('select 1 as ok');
                return { status: 'ok' };
            }
        }),
        runHealthCheck({
            name: 'kubernetes',
            handler: async () => {
                const raw = execSync('kubectl get namespace cars-operator-system -o json', { encoding: 'utf8' });
                const namespace = JSON.parse(raw);
                return {
                    status: 'ok',
                    details: { phase: namespace.status?.phase || 'Unknown' }
                };
            }
        }),
        runHealthCheck({
            name: 'startup',
            handler: async () => ({
                status: options.migrationsComplete ? 'ok' : 'error',
                message: options.migrationsComplete ? undefined : 'Database migrations are not complete'
            })
        }),
        runHealthCheck({
            name: 'wallets',
            handler: async () => ({
                status: options.mainnetWalletReady && options.testnetWalletReady ? 'ok' : 'error',
                message: options.mainnetWalletReady && options.testnetWalletReady ? undefined : 'One or more wallets are not ready',
                details: {
                    mainnetWalletReady: options.mainnetWalletReady,
                    testnetWalletReady: options.testnetWalletReady
                }
            })
        }),
        runHealthCheck({
            name: 'projects',
            critical: false,
            handler: async () => {
                const countRow = await db('projects').count('* as count').first();
                return {
                    status: 'ok',
                    details: {
                        totalProjects: Number((countRow as any)?.count || 0)
                    }
                };
            }
        })
    ]);

    const status = summarizeHealth(checks);
    return {
        status,
        live: status !== 'error',
        ready: status !== 'error',
        checks
    };
}

export async function collectProjectHealth(projectId: string, options: {
    includeRemoteBackendHealth?: boolean;
} = {}) {
    const namespace = namespaceForProject(projectId);
    const releaseName = releaseNameForProject(projectId);
    const resources = parseJsonCommand(`kubectl get deploy,sts,svc,pdb,hpa,ingress -n ${namespace} -o json`);
    const pods = parseJsonCommand(`kubectl get pods -n ${namespace} -o json`);
    let pxcResources: any[] = [];
    try {
        pxcResources = parseJsonCommand(`kubectl get pxc -n ${namespace} -o json`).items || [];
    } catch {
        pxcResources = [];
    }

    const items = resources.items || [];
    const appDeployment = items.find((item: any) => item.kind === 'Deployment' && item.metadata?.name === `${releaseName}-deployment`);
    const appService = items.find((item: any) => item.kind === 'Service' && item.metadata?.name === `${releaseName}-service`);
    const appIngresses = items.filter((item: any) => item.kind === 'Ingress');
    const appPdb = items.find((item: any) => item.kind === 'PodDisruptionBudget' && item.metadata?.name === `${releaseName}-deployment`);
    const appHpa = items.find((item: any) => item.kind === 'HorizontalPodAutoscaler' && item.metadata?.name === `${releaseName}-deployment`);
    const mongoStatefulSet = items.find((item: any) => item.kind === 'StatefulSet' && item.metadata?.name === 'mongo-rs');
    const mongoArbiter = items.find((item: any) => item.kind === 'Deployment' && item.metadata?.name === 'mongo-arbiter');
    const pxc = pxcResources[0];

    const appPods = (pods.items || []).filter((pod: any) => pod.metadata?.labels?.app === releaseName);
    const readyAppPods = appPods.filter((pod: any) => podReady(pod));
    const backendContainer = appDeployment?.spec?.template?.spec?.containers?.find((container: any) => container.name === 'backend');
    const deploymentId = typeof backendContainer?.image === 'string' ? backendContainer.image.split(':').slice(1).join(':') || null : null;

    const backendHosts = appIngresses.flatMap((ingress: any) =>
        (ingress.spec?.rules || [])
            .filter((rule: any) => (rule.http?.paths || []).some((path: any) => path.backend?.service?.port?.number === 8080))
            .map((rule: any) => rule.host)
    );
    const frontendHosts = appIngresses.flatMap((ingress: any) =>
        (ingress.spec?.rules || [])
            .filter((rule: any) => (rule.http?.paths || []).some((path: any) => path.backend?.service?.port?.number === 80))
            .map((rule: any) => rule.host)
    );
    const backendHost = backendHosts[0];

    const stickyIngress = appIngresses.length > 0 && appIngresses.every((ingress: any) =>
        ingress.metadata?.annotations?.['nginx.ingress.kubernetes.io/affinity'] === 'cookie' &&
        ingress.metadata?.annotations?.['nginx.ingress.kubernetes.io/session-cookie-name'] === 'route'
    );

    const checks = await Promise.all([
        runHealthCheck({
            name: 'app-deployment',
            handler: async () => {
                if (!appDeployment) {
                    throw new Error('App deployment is missing');
                }
                const desiredReplicas = appDeployment.spec?.replicas || 0;
                const readyReplicas = appDeployment.status?.readyReplicas || 0;
                return {
                    status: desiredReplicas > 0 && readyReplicas >= Math.min(desiredReplicas, 2) ? 'ok' : 'error',
                    details: { desiredReplicas, readyReplicas, deploymentId }
                };
            }
        }),
        runHealthCheck({
            name: 'app-pods',
            handler: async () => ({
                status: appPods.length > 0 && appPods.every((pod: any) => podReady(pod)) ? 'ok' : 'error',
                details: {
                    podCount: appPods.length,
                    readyPodCount: readyAppPods.length,
                    pods: appPods.map((pod: any) => ({
                        name: pod.metadata?.name,
                        node: pod.spec?.nodeName,
                        ready: podReady(pod)
                    }))
                }
            })
        }),
        runHealthCheck({
            name: 'service-stickiness',
            handler: async () => ({
                status: appService?.spec?.sessionAffinity === 'ClientIP' ? 'ok' : 'error',
                details: {
                    sessionAffinity: appService?.spec?.sessionAffinity,
                    timeoutSeconds: appService?.spec?.sessionAffinityConfig?.clientIP?.timeoutSeconds
                }
            })
        }),
        runHealthCheck({
            name: 'ingress-stickiness',
            critical: false,
            handler: async () => ({
                status: stickyIngress ? 'ok' : 'degraded',
                details: {
                    ingresses: appIngresses.map((ingress: any) => ({
                        name: ingress.metadata?.name,
                        affinity: ingress.metadata?.annotations?.['nginx.ingress.kubernetes.io/affinity'],
                        sessionCookieName: ingress.metadata?.annotations?.['nginx.ingress.kubernetes.io/session-cookie-name']
                    }))
                }
            })
        }),
        runHealthCheck({
            name: 'pdb',
            critical: false,
            handler: async () => ({
                status: appPdb ? 'ok' : 'degraded',
                details: { name: appPdb?.metadata?.name || null }
            })
        }),
        runHealthCheck({
            name: 'hpa',
            critical: false,
            handler: async () => ({
                status: appHpa ? 'ok' : 'degraded',
                details: {
                    name: appHpa?.metadata?.name || null,
                    minReplicas: appHpa?.spec?.minReplicas || null,
                    maxReplicas: appHpa?.spec?.maxReplicas || null
                }
            })
        }),
        runHealthCheck({
            name: 'mysql',
            handler: async () => {
                if (!pxc) {
                    return {
                        status: 'degraded',
                        message: 'No Percona cluster detected',
                        details: null
                    };
                }
                const ready = pxc.status?.ready || 0;
                const size = pxc.spec?.pxc?.size || 0;
                return {
                    status: ready >= size && size > 0 ? 'ok' : 'error',
                    details: {
                        name: pxc.metadata?.name,
                        ready,
                        size,
                        state: pxc.status?.state
                    }
                };
            }
        }),
        runHealthCheck({
            name: 'mongo',
            handler: async () => {
                if (!mongoStatefulSet) {
                    return {
                        status: 'degraded',
                        message: 'No mongo-rs StatefulSet detected',
                        details: null
                    };
                }
                const desiredMembers = mongoStatefulSet.spec?.replicas || 0;
                const readyMembers = mongoStatefulSet.status?.readyReplicas || 0;
                const arbiterReady = (mongoArbiter?.status?.readyReplicas || 0) >= 1;
                return {
                    status: desiredMembers > 0 && readyMembers >= desiredMembers && arbiterReady ? 'ok' : 'error',
                    details: {
                        desiredMembers,
                        readyMembers,
                        arbiterReady
                    }
                };
            }
        }),
        runHealthCheck({
            name: 'backend-http',
            handler: async () => {
                if (!options.includeRemoteBackendHealth || !backendHost) {
                    return {
                        status: 'degraded',
                        message: backendHost ? 'Remote backend probe skipped' : 'No backend host found',
                        details: { backendHost: backendHost || null }
                    };
                }
                const live = await fetchHttpHealth(`https://${backendHost}/health/live`);
                const ready = await fetchHttpHealth(`https://${backendHost}/health/ready`);
                return {
                    status: live.status === 'ok' && ready.status === 'ok' ? 'ok' : 'error',
                    details: {
                        backendHost,
                        live,
                        ready
                    }
                };
            }
        })
    ]);

    const status = summarizeHealth(checks);
    const online = status === 'ok';
    const issues = checks.filter(check => check.status !== 'ok').map(check => ({
        name: check.name,
        status: check.status,
        message: check.message
    }));

    return {
        status,
        online,
        namespace,
        releaseName,
        checkedAt: new Date().toISOString(),
        deploymentId,
        hosts: {
            frontend: frontendHosts[0] || null,
            backend: backendHost || null
        },
        app: {
            desiredReplicas: appDeployment?.spec?.replicas || 0,
            readyReplicas: appDeployment?.status?.readyReplicas || 0,
            podCount: appPods.length,
            readyPodCount: readyAppPods.length
        },
        traffic: {
            stickyService: appService?.spec?.sessionAffinity === 'ClientIP',
            stickyIngress
        },
        checks,
        issues
    };
}

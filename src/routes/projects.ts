import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import logger from '../logger';
import type { Knex } from 'knex';
import { Utils, Wallet } from '@bsv/sdk';
import { execSync } from 'child_process';
import dns from 'dns/promises';

const router = Router();

const VALID_LOG_PERIODS = ['5m', '15m', '30m', '1h', '2h', '6h', '12h', '1d', '2d', '7d'] as const;
const VALID_LOG_LEVELS = ['all', 'error', 'warn', 'info'] as const;
const MAX_TAIL_LINES = 10000;

type LogPeriod = typeof VALID_LOG_PERIODS[number];
type LogLevel = typeof VALID_LOG_LEVELS[number];

function isValidLogPeriod(period: string): period is LogPeriod {
    return VALID_LOG_PERIODS.includes(period as LogPeriod);
}

function isValidLogLevel(level: string): level is LogLevel {
    return VALID_LOG_LEVELS.includes(level as LogLevel);
}

function sanitizeTailValue(tail: number): number {
    return Math.min(Math.max(1, Math.floor(tail)), MAX_TAIL_LINES);
}

/**
 * Middleware to ensure user is registered
 */
async function requireRegisteredUser(req: Request, res: Response, next: Function) {
    const { db }: { db: Knex } = req as any;
    const identityKey = (req as any).authrite.identityKey;
    const user = await db('users').where({ identity_key: identityKey }).first();
    if (!user) {
        logger.warn({ identityKey }, 'User not registered');
        return res.status(401).json({ error: 'User not registered' });
    }
    (req as any).user = user;
    next();
}

/**
 * Check project existence
 */
async function requireProject(req: Request, res: Response, next: Function) {
    const { db }: { db: Knex } = req as any;
    const { projectId } = req.params;
    const project = await db('projects').where({ project_uuid: projectId }).first();
    if (!project) {
        logger.warn({ projectId }, 'Project not found');
        return res.status(404).json({ error: 'Project not found' });
    }
    (req as any).project = project;
    next();
}

/**
 * Check if user is project admin
 */
async function requireProjectAdmin(req: Request, res: Response, next: Function) {
    const { db }: { db: Knex } = req as any;
    const identityKey = (req as any).authrite.identityKey;
    const project = (req as any).project;

    const admin = await db('project_admins').where({ project_id: project.id, identity_key: identityKey }).first();
    if (!admin) {
        logger.warn({ identityKey, projectId: project.project_uuid }, 'User is not admin of project');
        return res.status(403).json({ error: 'User not admin' });
    }
    next();
}

async function requireDeployment(req: Request, res: Response, next: Function) {
    const { db }: { db: Knex } = req as any;
    const { deploymentId, projectId } = req.params;
    const deploy = await db('deploys').where({ deployment_uuid: deploymentId }).first();
    if (!deploy) {
        return res.status(404).json({ error: 'Deploy not found' });
    }
    const project = await db('projects').where({ id: deploy.project_id }).first();
    if (!project || project.project_uuid !== projectId) {
        return res.status(404).json({ error: 'Project not found for the given deployment' });
    }
    (req as any).deploy = deploy;
    (req as any).project = project;
    next();
}

async function requireProjectAdminForDeploy(req: Request, res: Response, next: Function) {
    const { db }: { db: Knex } = req as any;
    const identityKey = (req as any).authrite.identityKey;
    const deploy = (req as any).deploy;

    const admin = await db('project_admins').where({ project_id: deploy.project_id, identity_key: identityKey }).first();
    if (!admin) {
        return res.status(403).json({ error: 'Not admin of project' });
    }
    next();
}

/**
 * Create a new project
 * @body { name: string, network?: 'testnet'|'mainnet', privateKey?: string }
 */
router.post('/create', requireRegisteredUser, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const identityKey = (req as any).authrite.identityKey;
    let { name, network, privateKey } = req.body;
    const projectId = crypto.randomBytes(16).toString('hex');

    execSync(`kubectl create namespace cars-project-${projectId} || true`, { stdio: 'inherit' });
    logger.info(`Namespace cars-project-${projectId} ensured.`);

    // Generate a private key for the project if not provided
    if (!privateKey) {
        privateKey = crypto.randomBytes(32).toString('hex');
    } else {
        // Validate the provided private key: must be 64 lowercase hex characters
        if (!/^[0-9a-f]{64}$/.test(privateKey)) {
            return res.status(400).json({ error: 'Invalid private key' });
        }
    }

    const [projId] = await db('projects').insert({
        project_uuid: projectId,
        name: name || 'Unnamed Project',
        balance: 0,
        network: network === 'testnet' ? 'testnet' : 'mainnet',
        private_key: privateKey
    }, ['id']).returning('id');

    await db('project_admins').insert({
        project_id: projId,
        identity_key: identityKey
    });

    await db('logs').insert({
        project_id: projId.id,
        message: 'Project created'
    });

    logger.info({ projectId, name }, 'Project created');
    res.json({ projectId, message: 'Project created' });
});

/**
 * List projects where user is admin.
 * Returns project name, id, balance.
 */
router.post('/list', requireRegisteredUser, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const identityKey = (req as any).authrite.identityKey;

    const projects = await db('projects')
        .join('project_admins', 'projects.id', 'project_admins.project_id')
        .where('project_admins.identity_key', identityKey)
        .select('projects.project_uuid as id', 'projects.name', 'projects.balance', 'projects.created_at');

    res.json({ projects });
});

/**
 * Add Admin to a project
 * @body { identityKey: string }
 */
router.post('/:projectId/addAdmin', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;
    const { identityKey } = req.body;

    const user = await db('users').where({ identity_key: identityKey }).first();
    if (!user) {
        return res.status(400).json({ error: 'User not registered' });
    }

    const existing = await db('project_admins').where({ project_id: project.id, identity_key: identityKey }).first();
    if (!existing) {
        await db('project_admins').insert({ project_id: project.id, identity_key: identityKey });
        await db('logs').insert({
            project_id: project.id,
            message: `Admin added: ${identityKey}`
        });
        return res.json({ message: 'Admin added' });
    } else {
        return res.json({ message: 'User is already an admin' });
    }
});

/**
 * Remove Admin from a project
 * @body { identityKey: string }
 */
router.post('/:projectId/removeAdmin', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;
    const { identityKey } = req.body;

    const admins = await db('project_admins').where({ project_id: project.id });
    if (admins.length === 1 && admins[0].identity_key === identityKey) {
        return res.status(400).json({ error: 'Cannot remove last admin' });
    }

    const existing = admins.find(a => a.identity_key === identityKey);
    if (!existing) {
        return res.status(400).json({ error: 'User not an admin' });
    }

    await db('project_admins').where({ project_id: project.id, identity_key: identityKey }).del();
    await db('logs').insert({
        project_id: project.id,
        message: `Admin removed: ${identityKey}`
    });
    res.json({ message: 'Admin removed' });
});

/**
 * List admins for a project
 */
router.post('/:projectId/admins/list', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;

    const admins = await db('project_admins').where({ project_id: project.id }).select('identity_key');
    res.json({ admins: admins.map(a => a.identity_key) });
});

/**
 * List deployments for a project
 */
router.post('/:projectId/deploys/list', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;

    const deploys = await db('deploys').where({ project_id: project.id }).select('deployment_uuid');
    res.json({ deploys: deploys.map(d => d.deployment_uuid) });
});

/**
 * Create a new deploy for a project
 * @returns { deploymentId, url } - URL for uploading release files.
 */
router.post('/:projectId/deploy', requireRegisteredUser, async (req: Request, res: Response) => {
    const { db, wallet }: { db: Knex, wallet: Wallet } = req as any;
    const { projectId } = req.params;
    const identityKey = (req as any).authrite.identityKey;

    const project = await db('projects').where({ project_uuid: projectId }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const admin = await db('project_admins').where({ project_id: project.id, identity_key: identityKey }).first();
    if (!admin) return res.status(403).json({ error: 'Not admin of project' });

    const deploymentId = crypto.randomBytes(16).toString('hex');

    const [depId] = await db('deploys').insert({
        deployment_uuid: deploymentId,
        project_id: project.id,
        creator_identity_key: identityKey
    }, ['id']).returning('id');

    await db('logs').insert({
        project_id: project.id,
        deploy_id: depId,
        message: 'Deployment started'
    });

    const { signature } = await wallet.createSignature({
        data: Utils.toArray(deploymentId, 'hex'),
        protocolID: [2, 'url signing'],
        keyID: deploymentId,
        counterparty: 'self'
    });

    const uploadUrl = `${process.env.BASE_URL || 'http://localhost:7777'}/api/v1/upload/${deploymentId}/${Utils.toHex(signature)}`;
    res.json({
        url: uploadUrl,
        deploymentId,
        message: 'Deployment created'
    });
});

/**
 * Set Web UI Config for a project
 * @body { config: object }
 */
router.post('/:projectId/webui/config', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;
    const { config } = req.body;

    if (!config || typeof config !== 'object') {
        return res.status(400).json({ error: 'Invalid config - must be an object' });
    }

    try {
        JSON.stringify(config);
        await db('projects')
            .where({ id: project.id })
            .update({ web_ui_config: JSON.stringify(config) });

        await db('logs').insert({
            project_id: project.id,
            message: 'Web UI config updated'
        });

        res.json({ message: 'Web UI config updated' });
    } catch (error) {
        return res.status(400).json({ error: 'Invalid config - must be JSON serializable' });
    }
});

/**
 * Get project info and current cluster status
 * - Checks namespace, pods, and ingress rules in Kubernetes.
 */
router.post('/:projectId/info', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const project = (req as any).project;

    try {
        const namespace = `cars-project-${project.project_uuid}`;
        const status = {
            online: false,
            lastChecked: new Date(),
            domains: { ssl: false } as { frontend?: string; backend?: string; ssl: boolean },
            deploymentId: null as string | null
        };

        try {
            const podsOutput = execSync(`kubectl get pods -n ${namespace} -o json`);
            const pods = JSON.parse(podsOutput.toString());

            // Identify backend pod and extract deployment ID from its image tag
            const backendPod = pods.items.find((pod: any) =>
                pod.metadata.labels?.app === `${project.project_uuid}-backend`
            );
            if (backendPod) {
                const backendContainer = backendPod.spec.containers.find((c: any) => c.name === 'backend');
                if (backendContainer) {
                    const imageTag = backendContainer.image.split(':')[1];
                    status.deploymentId = imageTag;
                }
            }

            // Check if all pods are running and ready
            status.online = pods.items.length > 0 && pods.items.every((pod: any) =>
                pod.status.phase === 'Running' &&
                pod.status.containerStatuses?.every((container: any) => container.ready)
            );

            // Get ingress info
            const ingressOutput = execSync(`kubectl get ingress -n ${namespace} -o json`);
            const ingress = JSON.parse(ingressOutput.toString());

            ingress.items.forEach((ing: any) => {
                ing.spec.rules.forEach((rule: any) => {
                    const host = rule.host;
                    if (host.startsWith('frontend.')) {
                        status.domains.frontend = host;
                    } else if (host.startsWith('backend.')) {
                        status.domains.backend = host;
                    }
                });
                status.domains.ssl = ing.spec.tls?.length > 0;
            });

        } catch (error: any) {
            logger.error({ error: error.message }, 'Error checking project status');
        }

        res.json({
            id: project.project_uuid,
            name: project.name,
            network: project.network,
            status
        });
    } catch (error: any) {
        logger.error({ error: error.message }, 'Error getting project info');
        res.status(500).json({ error: 'Failed to get project info' });
    }
});

/**
 * ==============================
 * LOGGING ENDPOINTS
 * ==============================
 */

/**
 * PROJECT LOGS (SYSTEM-LEVEL)
 * Retrieve logs from the `logs` table that belong to the project but have no `deploy_id`.
 * These logs represent system-level or administrative actions related to the project.
 *
 * Endpoint: POST /:projectId/logs/project
 *
 * Response:
 *   { logs: string } - A joined string of logs.
 */
router.post('/:projectId/logs/project', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;

    const logs = await db('logs')
        .where({ project_id: project.id })
        .whereNull('deploy_id')
        .orderBy('timestamp', 'asc');

    const joinedLogs = logs.map(l => `[${l.timestamp}] ${l.message}`).join('\n');
    res.json({ logs: joinedLogs });
});

/**
 * DEPLOYMENT LOGS
 * Retrieve logs from the `logs` table that belong to a specific deployment.
 * These logs represent events that occurred during or for that particular deployment.
 *
 * Endpoint: POST /:projectId/logs/deployment/:deploymentId
 *
 * Response:
 *   { logs: string }
 */
router.post('/:projectId/logs/deployment/:deploymentId', requireRegisteredUser, requireProject, requireDeployment, requireProjectAdminForDeploy, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const deploy = (req as any).deploy;

    const logs = await db('logs')
        .where({ deploy_id: deploy.id })
        .orderBy('timestamp', 'asc');

    const joinedLogs = logs.map(l => `[${l.timestamp}] ${l.message}`).join('\n');
    res.json({ logs: joinedLogs });
});

/**
 * RESOURCE LOGS (CLUSTER-LEVEL)
 * Retrieve logs from Kubernetes pods for a given resource type within the project's namespace.
 *
 * Supported resources: 'frontend', 'backend', 'mongo', 'mysql'
 * Filters:
 *   - since: time period to look back (default: 1h)
 *   - tail: number of lines (default: 1000)
 *   - level: 'all', 'error', 'warn', 'info' (default: 'all')
 *
 * Endpoint: POST /:projectId/logs/resource/:resource
 * Request Body:
 *   {
 *     since?: '5m' | '15m' | '30m' | '1h' | '2h' | '6h' | '12h' | '1d' | '2d' | '7d',
 *     tail?: number,
 *     level?: 'all' | 'error' | 'warn' | 'info'
 *   }
 *
 * Response:
 *   {
 *     resource: string,
 *     logs: string,
 *     metadata: { podName: string, since: string, tail: number, level: string }
 *   }
 */
router.post('/:projectId/logs/resource/:resource', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const project = (req as any).project;
    const { resource } = req.params;
    const { since = '1h', tail = 1000, level = 'all' } = req.body;

    // Validate inputs
    if (!['frontend', 'backend', 'mongo', 'mysql'].includes(resource)) {
        return res.status(400).json({ error: 'Invalid resource type' });
    }

    if (!isValidLogPeriod(since)) {
        return res.status(400).json({
            error: 'Invalid time period',
            validPeriods: VALID_LOG_PERIODS
        });
    }

    if (!isValidLogLevel(level)) {
        return res.status(400).json({
            error: 'Invalid log level',
            validLevels: VALID_LOG_LEVELS
        });
    }

    const sanitizedTail = sanitizeTailValue(tail);

    try {
        const namespace = `cars-project-${project.project_uuid}`;
        const podsOutput = execSync(`kubectl get pods -n ${namespace} -o json`);
        const pods = JSON.parse(podsOutput.toString());

        if (!pods.items?.length) {
            return res.status(404).json({ error: `No ${resource} pods found` });
        }

        let logs
        if (resource === 'mongo' || resource === 'mysql') {
            const cmd = `kubectl logs -n ${namespace} ${resource} --since=${since} --tail=${sanitizedTail}`;
            logs = execSync(cmd).toString();
        } else {
            const pod = pods.items.find(x => x.metadata.name.startsWith('cars-project-'));
            if (!pod) {
                return res.status(404).json({ error: `No ${resource} pods found` });
            }
            const cmd = `kubectl logs -n ${namespace} ${pod.metadata.name} -c ${resource} --since=${since} --tail=${sanitizedTail}`;
            console.log(cmd)
            logs = execSync(cmd).toString();
        }

        // Filter logs by level if required
        let filteredLogs = logs;
        if (level !== 'all') {
            const levelPattern = new RegExp(`\\b${level.toUpperCase()}\\b`, 'i');
            filteredLogs = logs
                .split('\n')
                .filter(line => levelPattern.test(line))
                .join('\n');
        }

        res.json({
            resource,
            logs: filteredLogs,
            metadata: {
                since,
                tail: sanitizedTail,
                level
            }
        });
    } catch (error: any) {
        logger.error({ error: error.message }, 'Error getting resource logs');
        res.status(500).json({ error: 'Failed to get resource logs' });
    }
});

/**
 * Helper to validate and set a custom domain (for either frontend or backend).
 * This function:
 * - Validates domain format
 * - Queries DNS TXT records for `cars_project.<domain>`
 * - Expects a TXT record: cars-project-verification=<project_uuid>:<type>
 * - If not present, returns instructions. If present and correct, updates DB.
 */
async function handleCustomDomain(
    req: Request,
    res: Response,
    domainType: 'frontend' | 'backend'
) {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;

    const { domain } = req.body;
    if (!domain || typeof domain !== 'string' || !domain.match(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/)) {
        return res.status(400).json({ error: 'Invalid domain format. Please provide a valid domain (e.g. example.com)' });
    }

    // The expected TXT record
    const expectedRecord = `cars-project-verification=${project.project_uuid}:${domainType}`;

    const verificationHost = `cars_project.${domain}`;

    try {
        // Lookup TXT records
        const txtRecords = await dns.resolveTxt(verificationHost);

        // Flatten and search for our record
        const found = txtRecords.some(recordSet => recordSet.includes(expectedRecord));
        if (!found) {
            // Not found, return instructions
            const instructions = `Please create a DNS TXT record at:\n\n  ${verificationHost}\n\nWith the exact value:\n\n  ${expectedRecord}\n\nOnce this TXT record is in place, please try again.`;
            return res.status(400).json({ error: 'DNS verification failed', instructions });
        }

        // If found, update the database
        const updateField = domainType === 'frontend' ? 'frontend_custom_domain' : 'backend_custom_domain';
        await db('projects')
            .where({ id: project.id })
            .update({ [updateField]: domain });

        await db('logs').insert({
            project_id: project.id,
            message: `${domainType.charAt(0).toUpperCase() + domainType.slice(1)} custom domain set: ${domain}`
        });

        return res.json({ message: `${domainType.charAt(0).toUpperCase() + domainType.slice(1)} custom domain verified and set`, domain });
    } catch (err: any) {
        // DNS query failed or some other error
        logger.error({ err: err.message }, 'Error during DNS verification process');
        const instructions = `Please ensure that DNS is functioning and that you create a TXT record:\n\n  ${verificationHost}\n\nWith the value:\n\n  ${expectedRecord}\n\nThen try again.`;
        return res.status(400).json({ error: 'Failed to verify domain', instructions });
    }
}

/**
 * Set or verify a frontend custom domain for the project.
 * Body: { domain: string }
 * If DNS record is correct, updates database. Otherwise returns instructions.
 */
router.post('/:projectId/domains/frontend', requireRegisteredUser, requireProject, requireProjectAdmin, (req: Request, res: Response) => {
    return handleCustomDomain(req, res, 'frontend');
});

/**
 * Set or verify a backend custom domain for the project.
 * Body: { domain: string }
 * If DNS record is correct, updates database. Otherwise returns instructions.
 */
router.post('/:projectId/domains/backend', requireRegisteredUser, requireProject, requireProjectAdmin, (req: Request, res: Response) => {
    return handleCustomDomain(req, res, 'backend');
});

export default router;

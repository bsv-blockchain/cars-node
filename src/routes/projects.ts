import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import logger from '../logger';
import type { Knex } from 'knex';
import { Utils, Wallet } from '@bsv/sdk';
import { execSync } from 'child_process';
import dns from 'dns/promises';
import { sendAdminNotificationEmail, sendWelcomeEmail, sendDomainChangeEmail } from '../utils/email';
import { enableIngress } from '../utils/ingress';
import axios from 'axios';

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

    // Generate a random admin bearer token for OverlayExpress
    const adminBearerToken = crypto.randomBytes(32).toString('hex');

    // Provide some default advanced config
    const defaultEngineConfig = {
        syncConfiguration: {},
        logTime: false,
        logPrefix: '[CARS OVERLAY ENGINE] ',
        throwOnBroadcastFailure: false
    };

    const [projId] = await db('projects').insert({
        project_uuid: projectId,
        name: name || 'Unnamed Project',
        balance: 0,
        network: network === 'testnet' ? 'testnet' : 'mainnet',
        private_key: privateKey,
        engine_config: JSON.stringify(defaultEngineConfig),
        admin_bearer_token: adminBearerToken
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
 * TODO: THIS IS NOT YET ACTUALLY IMPLEMENTED
 * IT WILL USE THE NEW SERVICE MONETIZATION FRAMEWORK
 * Pay (add funds) to a project
 * @body { amount: number } - Amount in satoshis to add
 */
router.post('/:projectId/pay', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;
    const { amount } = req.body;

    if (typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({ error: 'Invalid amount. Must be a positive number.' });
    }

    const oldBalance = Number(project.balance);
    const newBalance = oldBalance + amount;
    await db('projects').where({ id: project.id }).update({ balance: newBalance });

    // Insert accounting record (credit)
    const metadata = { reason: 'Admin payment' };
    await db('project_accounting').insert({
        project_id: project.id,
        type: 'credit',
        amount_sats: amount,
        balance_after: newBalance,
        metadata: JSON.stringify(metadata)
    });

    await db('logs').insert({
        project_id: project.id,
        message: `Balance increased by ${amount}. New balance: ${newBalance}`
    });

    // If balance was negative and now is >=0, re-enable ingress
    if (oldBalance < 0 && newBalance >= 0) {
        const enabled = await enableIngress(project.project_uuid);
        if (enabled) { // TODO: This process could be handled better, when re-enabling after delinquency
            await db('logs').insert({
                project_id: project.id,
                message: `Ingress re-enabled after payment. Balance: ${newBalance}`
            });
        } else {
            await db('logs').insert({
                project_id: project.id,
                message: `Unable to re-enable ingress after payment, project needs to be redeployed.`
            });
        }
    }

    res.json({ message: `Paid ${amount} sats. New balance: ${newBalance}` });
});

/**
 * List projects where user is admin.
 * Returns project name, id, balance, created_at.
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
 * Helper to resolve a user by identityKey or email
 */
async function resolveUser(db: Knex, identityOrEmail: string) {
    let user = await db('users').where({ identity_key: identityOrEmail }).first();
    if (!user && identityOrEmail.includes('@')) {
        user = await db('users').where({ email: identityOrEmail }).first();
    }
    return user;
}

/**
 * Add Admin to a project
 * @body { identityKeyOrEmail: string }
 */
router.post('/:projectId/addAdmin', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;
    const user = (req as any).user; // Originating user
    const { identityKeyOrEmail } = req.body;

    const targetUser = await resolveUser(db, identityKeyOrEmail);
    if (!targetUser) {
        return res.status(400).json({ error: 'Target user not registered' });
    }

    const existing = await db('project_admins').where({ project_id: project.id, identity_key: targetUser.identity_key }).first();
    if (!existing) {
        await db('project_admins').insert({ project_id: project.id, identity_key: targetUser.identity_key });
        await db('logs').insert({
            project_id: project.id,
            message: `Admin added: ${targetUser.identity_key}`
        });

        // Notify all admins
        const admins = await db('project_admins')
            .join('users', 'users.identity_key', 'project_admins.identity_key')
            .where({ 'project_admins.project_id': project.id })
            .select('users.email', 'users.identity_key');

        const emails = admins.map((a: any) => a.email);
        const subject = `Admin Added to Project: ${project.name}`;
        const body = `Hello,

User ${targetUser.identity_key} (${targetUser.email}) has been added as an admin to project "${project.name}" (ID: ${project.project_uuid}).

Originated by: ${user.identity_key} (${user.email})

Regards,
CARS System`;

        await sendAdminNotificationEmail(emails, project, body, subject);

        // Send welcome email to the newly added admin
        const welcomeSubject = `You have been added as an admin to: ${project.name}`;
        const welcomeBody = `Hello,

You have been added as an admin to project "${project.name}" (ID: ${project.project_uuid}).

Originated by: ${user.identity_key} (${user.email})

Regards,
CARS System`;

        await sendWelcomeEmail(targetUser.email, project, welcomeBody, welcomeSubject);

        return res.json({ message: 'Admin added' });
    } else {
        return res.json({ message: 'User is already an admin' });
    }
});

/**
 * Remove Admin from a project
 * @body { identityKeyOrEmail: string }
 */
router.post('/:projectId/removeAdmin', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;
    const user = (req as any).user; // Originator
    const { identityKeyOrEmail } = req.body;

    const targetUser = await resolveUser(db, identityKeyOrEmail);
    if (!targetUser) {
        return res.status(400).json({ error: 'Target user not registered' });
    }

    const admins = await db('project_admins').where({ project_id: project.id });
    if (admins.length === 1 && admins[0].identity_key === targetUser.identity_key) {
        return res.status(400).json({ error: 'Cannot remove last admin' });
    }

    const existing = admins.find(a => a.identity_key === targetUser.identity_key);
    if (!existing) {
        return res.status(400).json({ error: 'User not an admin' });
    }

    await db('project_admins').where({ project_id: project.id, identity_key: targetUser.identity_key }).del();
    await db('logs').insert({
        project_id: project.id,
        message: `Admin removed: ${targetUser.identity_key}`
    });


    // Notify admins
    const adminList = await db('project_admins')
        .join('users', 'users.identity_key', 'project_admins.identity_key')
        .where({ 'project_admins.project_id': project.id })
        .select('users.email');

    const emails = adminList.map((a: any) => a.email);
    const subject = `Admin Removed from Project: ${project.name}`;
    const body = `Hello,

User ${targetUser.identity_key} (${targetUser.email}) has been removed as an admin from project "${project.name}" (ID: ${project.project_uuid}).

Originated by: ${user.identity_key} (${user.email})

Regards,
CARS System`;

    await sendAdminNotificationEmail(emails, project, body, subject);

    res.json({ message: 'Admin removed' });
});

/**
 * List admins for a project
 * Returns admin identity_key, email, added_at
 */
router.post('/:projectId/admins/list', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;

    const admins = await db('project_admins')
        .join('users', 'users.identity_key', 'project_admins.identity_key')
        .where({ project_id: project.id })
        .select('project_admins.identity_key', 'users.email', 'project_admins.added_at');

    res.json({ admins });
});

/**
 * List deployments for a project
 * Returns deployment_uuid and creation time
 */
router.post('/:projectId/deploys/list', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;

    const deploys = await db('deploys').where({ project_id: project.id }).select('deployment_uuid', 'created_at');
    res.json({ deploys });
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

    const uploadUrl = `${process.env.CARS_NODE_SERVER_BASEURL || 'http://localhost:7777'}/api/v1/upload/${deploymentId}/${Utils.toHex(signature)}`;
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
 * Get project info
 * Returns billing info, SSL, custom domains, web UI config, etc.
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

            // Identify backend pod
            const backendPod = pods.items.find((pod: any) =>
                pod.metadata.labels?.app === `cars-project-${project.project_uuid.substr(0, 24)}`
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

            // Get ingress info (may fail if ingress is disabled)
            try {
                const ingressOutput = execSync(`kubectl get ingress -n ${namespace} -o json`);
                const ingress = JSON.parse(ingressOutput.toString());

                ingress.items.forEach((ing: any) => {
                    if (!ing.spec.rules) return;
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
            } catch (ignore) {
                // ingress might be disabled
            }

        } catch (error: any) {
            logger.error({ error: error.message }, 'Error checking project status');
        }

        const billingInfo = {
            balance: Number(project.balance)
        };

        const customDomains = {
            frontend: project.frontend_custom_domain || null,
            backend: project.backend_custom_domain || null
        };

        const webUIConfig = project.web_ui_config ? JSON.parse(project.web_ui_config) : null;

        res.json({
            id: project.project_uuid,
            name: project.name,
            network: project.network,
            status,
            billing: billingInfo,
            sslEnabled: status.domains.ssl,
            customDomains,
            webUIConfig
        });
    } catch (error: any) {
        logger.error({ error: error.message }, 'Error getting project info');
        res.status(500).json({ error: 'Failed to get project info' });
    }
});

/**
 * Delete project endpoint
 * Removes all resources and sends email to admins.
 */
router.post('/:projectId/delete', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;
    const user = (req as any).user;

    const namespace = `cars-project-${project.project_uuid}`;
    const helmReleaseName = `cars-project-${project.project_uuid.substr(0, 24)}`;

    // Uninstall helm release
    try {
        execSync(`helm uninstall ${helmReleaseName} -n ${namespace}`, { stdio: 'inherit' });
    } catch (e) {
        logger.warn({ project_uuid: project.project_uuid }, 'Helm uninstall failed or not found. Continuing.');
    }

    // Delete namespace
    try {
        execSync(`kubectl delete namespace ${namespace}`, { stdio: 'inherit' });
    } catch (e) {
        logger.warn({ project_uuid: project.project_uuid }, 'Namespace deletion failed or not found. Continuing.');
    }

    // Gather admins
    const admins = await db('project_admins')
        .join('users', 'users.identity_key', 'project_admins.identity_key')
        .where({ 'project_admins.project_id': project.id })
        .select('users.email', 'users.identity_key');

    const emails = admins.map((a: any) => a.email);

    // Send notification email
    const subject = `Project Deleted: ${project.name}`;
    const body = `Hello,

Project "${project.name}" (ID: ${project.project_uuid}) has been deleted.

Originated by: ${user.identity_key} (${user.email})

All resources have been removed.

Regards,
CARS System`;

    await sendAdminNotificationEmail(emails, project, body, subject);

    // Delete from DB
    await db('project_accounting').where({ project_id: project.id }).del();
    await db('deploys').where({ project_id: project.id }).del();
    await db('project_admins').where({ project_id: project.id }).del();
    await db('logs').where({ project_id: project.id }).del();
    await db('projects').where({ id: project.id }).del();

    res.json({ message: 'Project deleted' });
});

/**
 * Project billing stats endpoint.
 * Query params (all optional):
 *  - resource?: CPU|MEMORY|DISK|NETWORK|ALL
 *  - type?: debit|credit
 *  - start?: timestamp
 *  - end?: timestamp
 * Add as you like; here we just implement a flexible filter.
 */
router.post('/:projectId/billing/stats', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;

    const { type, start, end } = req.body;

    let query = db('project_accounting').where({ project_id: project.id });

    if (type && ['debit', 'credit'].includes(type)) {
        query = query.andWhere({ type });
    }

    if (start) {
        query = query.andWhere('timestamp', '>=', new Date(start));
    }

    if (end) {
        query = query.andWhere('timestamp', '<=', new Date(end));
    }

    const records = await query.orderBy('timestamp', 'desc').select('*');

    res.json({ records });
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
 * - After successful verification, send notification email to admins.
 */
async function handleCustomDomain(
    req: Request,
    res: Response,
    domainType: 'frontend' | 'backend'
) {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;
    const user = (req as any).user;

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

        // Notify admins of domain change
        const admins = await db('project_admins')
            .join('users', 'users.identity_key', 'project_admins.identity_key')
            .where({ 'project_admins.project_id': project.id })
            .select('users.email');

        const emails = admins.map((a: any) => a.email);
        const subject = `Custom Domain Updated for Project: ${project.name}`;
        const body = `Hello,

The ${domainType} custom domain for project "${project.name}" (ID: ${project.project_uuid}) has been set to: ${domain}

Originated by: ${user.identity_key} (${user.email})

Regards,
CARS System`;

        await sendDomainChangeEmail(emails, project, body, subject);

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

/**
 * ==============================
 * ADVANCED ENGINE CONFIG
 * ==============================
 */

/**
 * Update advanced engine settings for this project.
 * This includes toggling GASP, request logging, sync config, etc.
 * Body can include partial updates:
 * {
 *   requestLogging?: boolean,
 *   gaspSync?: boolean,
 *   syncConfiguration?: Record<string, false | string[] | 'SHIP'>,
 *   logTime?: boolean,
 *   logPrefix?: string,
 *   throwOnBroadcastFailure?: boolean
 * }
 */
router.post('/:projectId/settings/update', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;

    let {
        requestLogging,
        gaspSync,
        syncConfiguration,
        logTime,
        logPrefix,
        throwOnBroadcastFailure
    } = req.body;

    // Load existing engine_config
    let engineConfig: any;
    try {
        engineConfig = project.engine_config ? JSON.parse(project.engine_config) : {};
    } catch (e) {
        engineConfig = {};
    }

    // Merge updates
    if (typeof requestLogging === 'boolean') {
        engineConfig.requestLogging = requestLogging;
    }
    if (typeof gaspSync === 'boolean') {
        engineConfig.gaspSync = gaspSync;
    }
    if (syncConfiguration && typeof syncConfiguration === 'object') {
        engineConfig.syncConfiguration = syncConfiguration;
    }
    if (typeof logTime === 'boolean') {
        engineConfig.logTime = logTime;
    }
    if (typeof logPrefix === 'string') {
        engineConfig.logPrefix = logPrefix;
    }
    if (typeof throwOnBroadcastFailure === 'boolean') {
        engineConfig.throwOnBroadcastFailure = throwOnBroadcastFailure;
    }

    // Save back to DB
    await db('projects').where({ id: project.id }).update({
        engine_config: JSON.stringify(engineConfig)
    });

    await db('logs').insert({
        project_id: project.id,
        message: 'Engine settings updated'
    });

    return res.json({ message: 'Engine settings updated successfully', engineConfig });
});

/**
 * ==============================
 * PROXY ADMIN ENDPOINTS
 * ==============================
 * Admins can request we call /admin/syncAdvertisements or /admin/startGASPSync
 * on their deployed OverlayExpress instance. We'll find the right domain,
 * attach the stored admin_bearer_token, and proxy the request.
 */

/**
 * Helper for constructing the backend domain for the project
 */
function getBackendDomain(project: any) {
    // If there's a custom backend domain, use that; otherwise, fallback to "backend.<project_uuid>.<PROJECT_DEPLOYMENT_DNS_NAME>"
    const projectsDomain = process.env.PROJECT_DEPLOYMENT_DNS_NAME!;
    return project.backend_custom_domain || `backend.${project.project_uuid}.${projectsDomain}`;
}

/**
 * Admin route: syncAdvertisements
 * We'll POST to https://<backend-domain>/admin/syncAdvertisements using Bearer token
 */
router.post('/:projectId/admin/syncAdvertisements', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const project = (req as any).project;
    const adminBearerToken = project.admin_bearer_token;
    if (!adminBearerToken) {
        return res.status(400).json({ error: 'No admin bearer token stored for this project' });
    }

    const backendDomain = getBackendDomain(project);
    const url = `https://${backendDomain}/admin/syncAdvertisements`;

    try {
        const response = await axios.post(url, {}, {
            headers: {
                Authorization: `Bearer ${adminBearerToken}`
            },
            timeout: 120000
        });
        return res.json({
            message: 'syncAdvertisements called successfully',
            data: response.data
        });
    } catch (error: any) {
        logger.error({ error: error.message, backendDomain }, 'syncAdvertisements proxy error');
        if (error.response) {
            return res.status(error.response.status).json({ error: error.response.data });
        }
        return res.status(500).json({ error: error.message });
    }
});

/**
 * Admin route: startGASPSync
 * We'll POST to https://<backend-domain>/admin/startGASPSync with Bearer token
 */
router.post('/:projectId/admin/startGASPSync', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const project = (req as any).project;
    const adminBearerToken = project.admin_bearer_token;
    if (!adminBearerToken) {
        return res.status(400).json({ error: 'No admin bearer token stored for this project' });
    }

    const backendDomain = getBackendDomain(project);
    const url = `https://${backendDomain}/admin/startGASPSync`;

    try {
        const response = await axios.post(url, {}, {
            headers: {
                Authorization: `Bearer ${adminBearerToken}`
            },
            timeout: 3600000
        });
        return res.json({
            message: 'startGASPSync called successfully',
            data: response.data
        });
    } catch (error: any) {
        logger.error({ error: error.message, backendDomain }, 'startGASPSync proxy error');
        if (error.response) {
            return res.status(error.response.status).json({ error: error.response.data });
        }
        return res.status(500).json({ error: error.message });
    }
});

export default router;

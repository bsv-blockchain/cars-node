import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import logger from '../logger';
import type { Knex } from 'knex';
import { Utils, Wallet } from '@bsv/sdk';

const router = Router();

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
    const { deploymentId } = req.params;
    const deploy = await db('deploys').where({ deployment_uuid: deploymentId }).first();
    if (!deploy) {
        return res.status(404).json({ error: 'Deploy not found' });
    }
    const project = await db('projects').where({ id: deploy.project_id }).first();
    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
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
 * @body { name: string }
 */
router.post('/create', requireRegisteredUser, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const identityKey = (req as any).authrite.identityKey;
    const { name } = req.body;
    const projectId = crypto.randomBytes(16).toString('hex');

    const [projId] = await db('projects').insert({
        project_uuid: projectId,
        name: name || 'Unnamed Project',
        balance: 0
    }, ['id']).returning('id');

    await db('project_admins').insert({
        project_id: projId,
        identity_key: identityKey
    });

    // log project creation
    await db('logs').insert({
        project_id: projId.id,
        message: 'Project created'
    });

    logger.info({ projectId, name }, 'Project created');
    res.json({ projectId, message: 'Project created' });
});

/**
 * List projects where user is admin. Return name, id, balance.
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
 * Add Admin
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
 * Remove Admin
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
 * List admins
 */
router.post('/:projectId/admins/list', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;

    const admins = await db('project_admins').where({ project_id: project.id }).select('identity_key');
    res.json({ admins: admins.map(a => a.identity_key) });
});

/**
 * List deployments
 */
router.post('/:projectId/deploys/list', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;

    const deploys = await db('deploys').where({ project_id: project.id }).select('deployment_uuid');
    res.json({ deploys: deploys.map(d => d.deployment_uuid) });
});

/**
 * Show project logs
 */
router.post('/:projectId/logs/show', requireRegisteredUser, requireProject, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const project = (req as any).project;

    const logs = await db('logs').where({ project_id: project.id }).orderBy('timestamp', 'asc');
    // Return logs as a single text for now
    const joinedLogs = logs.map(l => `[${l.timestamp}] ${l.message}`).join('\n');
    res.json({ logs: joinedLogs });
});

/**
 * Create a new deploy
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
 * Show deploy logs
 */
router.post('/deploy/:deploymentId/logs/show', requireRegisteredUser, requireDeployment, requireProjectAdmin, async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const deploy = (req as any).deploy;

    const logs = await db('logs').where({ deploy_id: deploy.id }).orderBy('timestamp', 'asc');
    const joinedLogs = logs.map(l => `[${l.timestamp}] ${l.message}`).join('\n');
    res.json({ logs: joinedLogs });
});

export default router;

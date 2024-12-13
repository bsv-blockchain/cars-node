import { Request, Response } from 'express';
import fs from 'fs-extra';
import path from 'path';
import { Utils, Wallet } from '@bsv/sdk';
import type { Knex } from 'knex';
import { execSync } from 'child_process';
import logger from '../logger';

export default async (req: Request, res: Response) => {
    const { db, wallet }: { db: Knex, wallet: Wallet } = req as any;
    const { deploymentId, signature } = req.params;

    const deploy = await db('deploys').where({ deployment_uuid: deploymentId }).first();
    const project = await db('projects').where({ id: deploy.project_id }).first();
    if (!deploy) {
        return res.status(400).json({ error: 'Invalid deploymentId' });
    }

    const { valid } = await wallet.verifySignature({
        data: Utils.toArray(deploymentId, 'hex'),
        signature: Utils.toArray(signature, 'hex'),
        protocolID: [2, 'url signing'],
        keyID: deploymentId,
        counterparty: 'self'
    });

    if (!valid) {
        return res.status(401).json({ error: 'Invalid signature' });
    }

    // Store file locally
    const filePath = path.join('/tmp', `artifact_${deploymentId}.tgz`);
    fs.writeFileSync(filePath, req.body); // raw data

    await db('deploys').where({ id: deploy.id }).update({
        file_path: filePath
    });

    await db('logs').insert({
        project_id: deploy.project_id,
        deploy_id: deploy.id,
        message: `File uploaded successfully, saved to ${filePath}`
    });

    // Create upload directory
    const uploadDir = path.join('/tmp', `build_${deploymentId}`);
    fs.ensureDirSync(uploadDir);

    // Extract tarball
    execSync(`tar -xzf ${filePath} -C ${uploadDir}`);

    logger.info(`Tarball extracted at ${uploadDir}`, { deploymentId });
    await db('logs').insert({
        project_id: deploy.project_id,
        deploy_id: deploy.id,
        message: `Tarball extracted at ${uploadDir}`
    });

    // Validate deployment-info.json
    const deploymentInfoPath = path.join(uploadDir, 'deployment-info.json');
    if (!fs.existsSync(deploymentInfoPath)) {
        const errMsg = 'deployment-info.json not found in tarball.';
        logger.error(errMsg, { deploymentId });
        await db('logs').insert({
            project_id: deploy.project_id,
            deploy_id: deploy.id,
            message: errMsg
        });
        return res.status(400).json({ error: errMsg });
    }

    const deploymentInfo = JSON.parse(fs.readFileSync(deploymentInfoPath, 'utf-8'));

    // Validate projectId and config
    if (deploymentInfo.schema !== 'bsv-app') {
        const errMsg = 'Invalid schema in deployment-info.json';
        logger.error(errMsg, { deploymentId });
        await db('logs').insert({
            project_id: deploy.project_id,
            deploy_id: deploy.id,
            message: errMsg
        });
        return res.status(400).json({ error: errMsg });
    }

    // Find the associated config
    const carsConfig = deploymentInfo.configs.find((c: any) => c.provider === 'CARS' && c.projectID === project.project_uuid);
    if (!carsConfig || !carsConfig.projectID) {
        const errMsg = 'No matching CARS config or projectID in deployment-info.json';
        logger.error(errMsg, { deploymentId });
        await db('logs').insert({
            project_id: deploy.project_id,
            deploy_id: deploy.id,
            message: errMsg
        });
        return res.status(400).json({ error: errMsg });
    }

    // Decide what to build based on deployment-info.json
    const deployTargets = carsConfig.deploy || [];
    const backendEnabled = deployTargets.includes('backend');
    const frontendEnabled = deployTargets.includes('frontend');

    // Build images
    // We'll create image names like: registry:5000/cars-project-<project_uuid>/backend:<releaseId>
    const registryHost = 'cars-registry:5000';
    let backendImage: string | null = null;
    let frontendImage: string | null = null;

    if (backendEnabled) {
        backendImage = `${registryHost}/cars-project-${project.project_uuid}/backend:${deploymentId}`;
        await db('logs').insert({ project_id: deploy.project_id, deploy_id: deploy.id, message: 'Building backend image...' });
        logger.info('Building backend image...', { deploymentId });

        // Docker build backend
        const backendDir = path.join(uploadDir, 'backend');
        if (!fs.existsSync(backendDir)) {
            const errMsg = 'Backend directory not found but backend deployment requested.';
            logger.error(errMsg, { deploymentId });
            await db('logs').insert({ project_id: deploy.project_id, deploy_id: deploy.id, message: errMsg });
            return res.status(400).json({ error: errMsg });
        }

        execSync(`docker build -t ${backendImage} ${backendDir}`, { stdio: 'inherit' });
        logger.info(`Backend image built: ${backendImage}`);
        await db('logs').insert({ project_id: deploy.project_id, deploy_id: deploy.id, message: `Backend image built: ${backendImage}` });

        // Push backend image
        execSync(`docker push ${backendImage}`, { stdio: 'inherit' });
        logger.info(`Backend image pushed: ${backendImage}`, { deploymentId });
        await db('logs').insert({ project_id: deploy.project_id, deploy_id: deploy.id, message: `Backend image pushed: ${backendImage}` });
    }

    if (frontendEnabled) {
        frontendImage = `${registryHost}/cars-project-${project.project_uuid}/frontend:${deploymentId}`;
        await db('logs').insert({ project_id: deploy.project_id, deploy_id: deploy.id, message: 'Building frontend image...' });
        logger.info('Building frontend image...', { deploymentId });

        const frontendDir = path.join(uploadDir, 'frontend');
        if (!fs.existsSync(frontendDir)) {
            const errMsg = 'Frontend directory not found but frontend deployment requested.';
            logger.error(errMsg, { deploymentId });
            await db('logs').insert({ project_id: deploy.project_id, deploy_id: deploy.id, message: errMsg });
            return res.status(400).json({ error: errMsg });
        }

        // Assume the frontend is a static directory

        // Now create a Dockerfile for frontend that serves files with nginx
        fs.writeFileSync(path.join(frontendDir, 'Dockerfile'), `FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80`);

        execSync(`docker build -t ${frontendImage} ${frontendDir}`, { stdio: 'inherit' });
        logger.info(`Frontend image built: ${frontendImage}`, { deploymentId });
        await db('logs').insert({ project_id: deploy.project_id, deploy_id: deploy.id, message: `Frontend image built: ${frontendImage}` });

        execSync(`docker push ${frontendImage}`, { stdio: 'inherit' });
        logger.info(`Frontend image pushed: ${frontendImage}`, { deploymentId });
        await db('logs').insert({ project_id: deploy.project_id, deploy_id: deploy.id, message: `Frontend image pushed: ${frontendImage}` });
    }

    ///// WIP /////

    // If required, also build and push images for other services or steps defined in deployment-info.json.
    // E.g., if there's a contracts language sCrypt and we compiled contracts.

    // Once images are ready, generate a Helm chart dynamically.
    // The chart might be generic, just need custom values.
    const helmValuesPath = path.join(uploadDir, 'values.generated.yaml');
    const helmValues = {
        image: {},
        // Possibly define keys only if backend/frontend exists
        ...(backendEnabled ? { backendImage } : {}),
        ...(frontendEnabled ? { frontendImage } : {}),
        // If DB services are needed, we define them here:
        // e.g., if the deployment-info says we need MySQL/Mongo per project, we might add subcharts or references.
        // This can be as complex as needed, for now let's just show them:
        db: {
            mysql: carsConfig.network === 'mainnet' ? 'mysql-mainnet' : 'mysql-testnet'
        }
    };

    fs.writeFileSync(helmValuesPath, JSON.stringify(helmValues, null, 2));

    await db('logs').insert({ project_id: deploy.project_id, message: `Helm values generated at ${helmValuesPath}` });
    logger.info(`Helm values generated at ${helmValuesPath}`);

    // Deploy with helm. We'll assume we have a base chart in /app/helm-chart that references .Values.backendImage/.frontendImage
    const namespace = `cars-project-${projectId}`;
    execSync(`kubectl create namespace ${namespace} || true`, { stdio: 'inherit' });
    logger.info(`Namespace ${namespace} ensured.`);
    await db('logs').insert({ project_id: deploy.project_id, message: `Namespace ${namespace} ensured.` });

    const helmReleaseName = `cars-project-${projectId}-${releaseId}`;
    execSync([
        'helm', 'upgrade', '--install', helmReleaseName, '/app/helm-chart',
        '--namespace', namespace,
        '-f', helmValuesPath
    ].join(' '), { stdio: 'inherit' });

    logger.info(`Helm release ${helmReleaseName} deployed`);
    await db('logs').insert({ project_id: deploy.project_id, message: `Helm release ${helmReleaseName} deployed` });

    // Wait for rollout
    execSync(`kubectl rollout status deployment/${helmReleaseName}-deployment -n ${namespace}`, { stdio: 'inherit' });
    logger.info(`Project ${projectId}, release ${releaseId} successfully rolled out.`);
    await db('logs').insert({ project_id: deploy.project_id, message: `Project ${projectId}, release ${releaseId} rolled out successfully.` });

    res.json({ message: 'File uploaded', size: req.body.length });
}
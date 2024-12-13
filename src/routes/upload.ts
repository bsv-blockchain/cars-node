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

    if (backendEnabled) {
        // TODO: Refine this and align it with LARS, and how the LARS container is assembled.
        // We do not have a Dockerfile already in the backend, we need to assemble one.
        // To do this, we need to do a similar process to LARS. We also need to synthesize the index.ts file, package.json, and the other files.
        // We need to pay attention to the directory structure, the same way that LARS does for its backend container image builds.
        // This container needs to incorporate @bsv/overlay-express.
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

        // ... create Dockerfile, etc ...

        execSync(`docker build -t ${backendImage} ${backendDir}`, { stdio: 'inherit' });
        logger.info(`Backend image built: ${backendImage}`);
        await db('logs').insert({ project_id: deploy.project_id, deploy_id: deploy.id, message: `Backend image built: ${backendImage}` });

        // Push backend image
        execSync(`docker push ${backendImage}`, { stdio: 'inherit' });
        logger.info(`Backend image pushed: ${backendImage}`, { deploymentId });
        await db('logs').insert({ project_id: deploy.project_id, deploy_id: deploy.id, message: `Backend image pushed: ${backendImage}` });
    }

    // Once images are ready, generate a Helm chart dynamically.
    // When there's a frontend, it is added to the chart.
    // When there's a backend, it's also added, along with mysql and mongo images.
    // Every project has its own mysql and mongo images, which are never shared across projects.
    // This is analogous to how LARS generates and runs its docker-compose.
    // Do not use values, instead just directly and dynamically generate the correct chart, as appropriate.
    // LARS: would generate and execute a docker-compose.yml file as appropriate.
    // CARS (this system): must therefore generate and then deploy it with Helm.
    // NOTE: For resources that persist across releases, like the mysql and mongo databases, only deploy them once.
    // In the chart and backend image, ensure that environmental variables are passed, as appropriate, so that the backend can access its associated databases.

    // ....

    // ... Deploy with helm ...
    const namespace = `cars-project-${project.project_uuid}`;
    const helmReleaseName = `cars-project-${project.project_uuid}-${deploymentId}`;
    execSync([
        'helm', 'upgrade', '--install', helmReleaseName, '/app/helm-chart'/* USE DYNAMICALLY GENERATED CHART HERE!!! */,
        '--namespace', namespace
    ].join(' '), { stdio: 'inherit' });

    logger.info(`Helm release ${helmReleaseName} deployed`, { deploymentId });
    await db('logs').insert({ project_id: deploy.project_id, deploy_id: deploy.id, message: `Helm release ${helmReleaseName} deployed` });

    // Wait for rollout
    execSync(`kubectl rollout status deployment/${helmReleaseName}-deployment -n ${namespace}`, { stdio: 'inherit' });
    logger.info(`Project ${project.project_uuid}, release ${deploymentId} successfully rolled out.`, { deploymentId });
    await db('logs').insert({ project_id: deploy.project_id, deploy_id: deploy.id, message: `Project ${project.project_uuid}, release ${deploymentId} rolled out successfully.` });

    // ... update the nginx ingress controller to point the project subdomain to the new release ...

    res.json({ message: 'File uploaded', size: req.body.length });
}
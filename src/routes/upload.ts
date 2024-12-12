import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { Utils, Wallet } from '@bsv/sdk';
import type { Knex } from 'knex';

export default async (req: Request, res: Response) => {
    const { db, wallet }: { db: Knex, wallet: Wallet } = req as any;
    const { deploymentId, signature } = req.params;

    const deploy = await db('deploys').where({ deployment_uuid: deploymentId }).first();
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
        message: 'File uploaded successfully'
    });

    res.json({ message: 'File uploaded', size: req.body.length });
}
import { Router, Request, Response } from 'express';
import logger from '../logger';
import type { Knex } from 'knex';
const router = Router();

router.post('/register', async (req: Request, res: Response) => {
    const { db }: { db: Knex } = req as any;
    const identityKey = (req as any).auth.identityKey;
    try {
        const certs = (req as any).auth.certificates;
        let email: string | undefined
        if (certs && certs.length) {
            email = certs[0].decryptedFields.email;
        } else {
            email = 'placeholder@domain.com' // temporary
        }

        // Insert user if not exists
        const existing = await db('users').where({ identity_key: identityKey }).first();
        if (!existing) {
            await db('users').insert({ identity_key: identityKey, email });
            logger.info({ identityKey, email }, 'User registered');
        } else {
            logger.info({ identityKey }, 'User already registered');
        }

        const userCount = await db('users').count('* as cnt').first();
        res.json({ message: 'User registered', userCount: userCount.cnt });
    } catch (e) {
        res.status(400).json({ message: 'Invalid or missing email certificate' })
    }
});

export default router;

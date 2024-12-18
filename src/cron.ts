import { CronJob } from 'cron';
import { checkAndFundProjectKeys } from './utils/wallet';
import logger from './logger';
import type { Knex } from 'knex';
import type { Wallet } from '@bsv/sdk';
import { checkAndIssueCertificates } from './utils/SSLManager';

export function startCronJobs(db: Knex, wallet: Wallet) {
    // Check project keys every 5 minutes
    new CronJob(
        '*/5 * * * *',
        async () => {
            logger.info('Running cron jobs')
            try {
                await checkAndFundProjectKeys(db, wallet);
            } catch (error) {
                logger.error('Error in project keys cron job:', error);
            }
            try {
                await checkAndIssueCertificates();
            } catch (error) {
                logger.error('Error in SSL certificates cron job', error);
            }
        },
        null,
        true
    );

    logger.info('Cron jobs started');
} 
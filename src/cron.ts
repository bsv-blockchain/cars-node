import { CronJob } from 'cron';
import { checkAndFundProjectKeys } from './utils/wallet';
import logger from './logger';
import type { Knex } from 'knex';
import type { Wallet } from '@bsv/sdk';

export function startCronJobs(db: Knex, wallet: Wallet) {
    // Check project keys every 5 minutes
    new CronJob(
        '*/5 * * * *',
        async () => {
            try {
                await checkAndFundProjectKeys(db, wallet);
            } catch (error) {
                logger.error('Error in project keys cron job:', error);
            }
        },
        null,
        true
    );

    logger.info('Cron jobs started');
} 
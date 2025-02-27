import { CronJob } from 'cron';
import { checkAndFundProjectKeys } from './utils/wallet';
import logger from './logger';
import type { Knex } from 'knex';
import { checkAndIssueCertificates } from './utils/SSLManager';
import { billProjects } from './utils/billing';
import { WalletInterface } from '@bsv/sdk';

export function startCronJobs(db: Knex, mainnetWalelt: WalletInterface, testnetWallet: WalletInterface) {
    // Check project keys every 5 minutes
    new CronJob(
        '*/5 * * * *',
        async () => {
            logger.info('Running cron jobs')
            try {
                await checkAndFundProjectKeys(db, mainnetWalelt, testnetWallet);
            } catch (error) {
                logger.error('Error in project keys cron job:', error);
            }
            try {
                await checkAndIssueCertificates();
            } catch (error) {
                logger.error('Error in SSL certificates cron job', error);
            }
            try {
                await billProjects();
            } catch (error) {
                logger.error('Error in project billing cron job', error);
            }
        },
        null,
        true
    );

    logger.info('Cron jobs started');
} 
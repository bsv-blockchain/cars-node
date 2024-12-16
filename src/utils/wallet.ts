import { Wallet, ProtoWallet, PrivateKey, P2PKH, PublicKey } from '@bsv/sdk';
import type { Knex } from 'knex';
import logger from '../logger';
import { Ninja, NinjaSubmitDirectTransactionApi, NinjaSubmitDirectTransactionParams } from 'ninja-base';
import crypto from 'crypto';

export async function findBalanceForKey(privateKey: string, network: 'mainnet' | 'testnet' = 'mainnet'): Promise<number> {
    if (network === 'testnet') {
        throw new Error('Testnet balance checking not implemented');
    }
    const ninja = new Ninja({ privateKey });
    const balance = await ninja.getTotalValue();
    return balance.total;
}

export async function fundKey(
    fromPrivateKey: string,
    toPrivateKey: string,
    amount: number,
    network: 'mainnet' | 'testnet' = 'mainnet'
): Promise<boolean> {
    if (network === 'testnet') {
        throw new Error('Testnet funding not implemented');
    }
    const serverBalance = await findBalanceForKey(fromPrivateKey, network);
    if (serverBalance < amount) {
        throw new Error('Server balance is insufficient for funding');
    }
    const fromNinja = new Ninja({ privateKey: fromPrivateKey });
    const fromWallet = new ProtoWallet(new PrivateKey(fromPrivateKey, 16));
    const toNinja = new Ninja({ privateKey: toPrivateKey });
    const derivationPrefix = crypto.randomBytes(10).toString('base64');
    const derivationSuffix = crypto.randomBytes(10).toString('base64');
    const { publicKey: derivedPublicKey } = await fromWallet.getPublicKey({
        counterparty: new PrivateKey(toPrivateKey, 16).toPublicKey().toString(),
        protocolID: [2, '3241645161d8'],
        keyID: `${derivationPrefix} ${derivationSuffix}`
    });
    const script = new P2PKH().lock(PublicKey.fromString(derivedPublicKey).toAddress()).toHex();
    const outputs = [{
        script,
        satoshis: amount
    }];
    const transaction = await fromNinja.getTransactionWithOutputs({
        outputs,
        note: 'Funding Local Overlay Services host for development'
    });
    const directTransaction: NinjaSubmitDirectTransactionParams = {
        derivationPrefix,
        transaction: {
            ...transaction,
            outputs: [{
                vout: 0,
                satoshis: amount,
                derivationSuffix
            }]
        } as NinjaSubmitDirectTransactionApi,
        senderIdentityKey: (await fromWallet.getPublicKey({ identityKey: true })).publicKey,
        protocol: '3241645161d8' as any,
        note: 'Incoming payment from KeyFunder'
    };
    await toNinja.submitDirectTransaction(directTransaction);
    return true;
}

export async function checkAndFundProjectKeys(db: Knex, wallet: Wallet) {
    const projects = await db('projects')
        .select('projects.*')
        .where('balance', '>', 0);

    for (const project of projects) {
        const key = project.private_key;
        const balance = await findBalanceForKey(key.private_key, project.network);

        if (balance < 30000) {
            const neededAmount = 30000 - balance;

            // For testnet, use 10% of mainnet threshold
            const fundingAmount = project.network === 'testnet'
                ? Math.min(neededAmount, project.balance * 0.1)
                : Math.min(neededAmount, project.balance);

            if (fundingAmount <= 5000) continue;

            const sourceKey = project.network === 'mainnet'
                ? process.env.MAINNET_PRIVATE_KEY
                : process.env.TESTNET_PRIVATE_KEY;

            if (!sourceKey) {
                logger.error(`Missing CARS ${key.network} key`);
                continue;
            }

            const funded = await fundKey(
                sourceKey,
                project.private_key,
                fundingAmount,
                project.network
            );

            if (funded) {

                if (key.network === 'mainnet') {
                    await db('projects')
                        .where({ id: project.id })
                        .decrement('balance', fundingAmount);
                } else {
                    await db('projects')
                        .where({ id: project.id })
                        .decrement('balance', Math.round(fundingAmount / 10));
                }

                logger.info({
                    projectId: project.project_uuid,
                    network: project.network,
                    amount: fundingAmount
                }, 'Project key funded');
            }
        }
    }
}
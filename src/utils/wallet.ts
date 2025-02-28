import { WalletInterface, PrivateKey, P2PKH, PublicKey, KeyDeriver, InternalizeActionArgs } from '@bsv/sdk';
import type { Knex } from 'knex';
import logger from '../logger';
import crypto from 'crypto';
import { Services, StorageClient, Wallet, WalletSigner, WalletStorageManager } from '@bsv/wallet-toolbox-client';

export async function makeWallet(chain: 'test' | 'main', privateKey: string): Promise<WalletInterface> {
    const keyDeriver = new KeyDeriver(new PrivateKey(privateKey, 'hex'));
    const storageManager = new WalletStorageManager(keyDeriver.identityKey);
    const signer = new WalletSigner(chain, keyDeriver, storageManager);
    const services = new Services(chain);
    const wallet = new Wallet(signer, services);
    const client = new StorageClient(
        wallet,
        // Hard-code storage URLs for now, but this should be configurable in the future along with the private key.
        chain === 'test' ? 'https://staging-storage.babbage.systems' : 'https://storage.babbage.systems'
    );
    await client.makeAvailable();
    await storageManager.addWalletStorageProvider(client);
    return wallet;
}

export async function findBalanceForKey(privateKey: string, network: 'mainnet' | 'testnet' = 'mainnet'): Promise<number> {
    const wallet = await makeWallet(network === 'mainnet' ? 'main' : 'test', privateKey);
    const { outputs: outputsInDefaultBasket } = await wallet.listOutputs({ basket: 'default', limit: 10000 });
    const balance = outputsInDefaultBasket.reduce((a, e) => a + e.satoshis, 0);
    return balance;
}

export async function fundKey(
    fromWallet: WalletInterface,
    toPrivateKey: string,
    amount: number,
    network: 'mainnet' | 'testnet' = 'mainnet'
): Promise<boolean> {
    const { outputs: outputsInDefaultBasket } = await fromWallet.listOutputs({ basket: 'default', limit: 10000 });
    const serverBalance = outputsInDefaultBasket.reduce((a, e) => a + e.satoshis, 0);
    if (serverBalance < amount) {
        throw new Error('Server balance is insufficient for funding');
    }
    const toWallet = await makeWallet(network === 'mainnet' ? 'main' : 'test', toPrivateKey);
    const derivationPrefix = crypto.randomBytes(10).toString('base64');
    const derivationSuffix = crypto.randomBytes(10).toString('base64');
    const { publicKey: payer } = await fromWallet.getPublicKey({ identityKey: true })
    const payee = new PrivateKey(toPrivateKey, 16).toPublicKey().toString()
    const { publicKey: derivedPublicKey } = await fromWallet.getPublicKey({
        counterparty: payee,
        protocolID: [2, '3241645161d8'],
        keyID: `${derivationPrefix} ${derivationSuffix}`
    });
    const lockingScript = new P2PKH().lock(PublicKey.fromString(derivedPublicKey).toAddress()).toHex();
    const outputs = [{
        lockingScript,
        satoshis: amount,
        outputDescription: 'Fund a CARS key',
        customInstructions: JSON.stringify({ derivationPrefix, derivationSuffix, payee })
    }];
    const transaction = await fromWallet.createAction({
        outputs,
        description: 'Funding CARS host for SHIP/SLAP',
        options: {
            randomizeOutputs: false
        }
    });
    const directTransaction: InternalizeActionArgs = {
        tx: transaction.tx!,
        outputs: [{
            outputIndex: 0,
            protocol: 'wallet payment',
            paymentRemittance: {
                derivationPrefix,
                derivationSuffix,
                senderIdentityKey: payer
            }
        }],
        description: 'Payment from CARS hosting provider for SHIP/SLAP'
    };
    await toWallet.internalizeAction(directTransaction);
    return true;
}

export async function checkAndFundProjectKeys(db: Knex, mainnetWalelt: WalletInterface, testnetWallet: WalletInterface) {
    const projects = await db('projects')
        .select('projects.*')
        .where('balance', '>', 0);

    for (const project of projects) {
        try {
            const key = project.private_key;
            const balance = await findBalanceForKey(key.private_key, project.network);

            if (balance < 30000) {
                const neededAmount = 30000 - balance;

                // For testnet, use 10% of mainnet threshold
                const fundingAmount = project.network === 'testnet'
                    ? Math.min(neededAmount, project.balance * 0.1)
                    : Math.min(neededAmount, project.balance);

                if (fundingAmount <= 5000) continue;

                const sourceWallet = project.network === 'mainnet'
                    ? mainnetWalelt
                    : testnetWallet

                const funded = await fundKey(
                    sourceWallet,
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
        } catch (e) {
            continue
        }
    }
}
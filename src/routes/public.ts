import { ProtoWallet, PrivateKey } from '@bsv/sdk';

export default async (_, res) => {
    const mainnetKey = process.env.MAINNET_PRIVATE_KEY || '';
    const testnetKey = process.env.TESTNET_PRIVATE_KEY || '';
    const projectDomain = process.env.PROJECT_DEPLOYMENT_DNS_NAME || 'example.com';

    const cpuRate = parseInt(process.env.CPU_RATE_PER_CORE_5MIN || "1000", 10);
    const memRate = parseInt(process.env.MEM_RATE_PER_GB_5MIN || "500", 10);
    const diskRate = parseInt(process.env.DISK_RATE_PER_GB_5MIN || "100", 10);
    const netRate = parseInt(process.env.NET_RATE_PER_GB_5MIN || "200", 10);

    const mainnetWallet = new ProtoWallet(new PrivateKey(mainnetKey, 16));
    const testnetWallet = new ProtoWallet(new PrivateKey(testnetKey, 16));

    const mainnetPubKey = await mainnetWallet.getPublicKey({ identityKey: true });
    const testnetPubKey = await testnetWallet.getPublicKey({ identityKey: true });

    res.json({
        mainnetPublicKey: mainnetPubKey,
        testnetPublicKey: testnetPubKey,
        pricing: {
            cpu_rate_per_5min: cpuRate,
            mem_rate_per_gb_5min: memRate,
            disk_rate_per_gb_5min: diskRate,
            net_rate_per_gb_5min: netRate
        },
        projectDeploymentDomain: projectDomain
    });
}

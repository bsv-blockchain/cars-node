import logger from '../logger';
import { sendThresholdEmail } from './email';
import axios from 'axios';
import db from '../db';
import { disableIngress, enableIngress } from './ingress';

// Configurable billing rates (default values as before)
const CPU_RATE_PER_CORE_5MIN = parseInt(process.env.CPU_RATE_PER_CORE_5MIN || "1000", 10);
const MEM_RATE_PER_GB_5MIN = parseInt(process.env.MEM_RATE_PER_GB_5MIN || "500", 10);
const DISK_RATE_PER_GB_5MIN = parseInt(process.env.DISK_RATE_PER_GB_5MIN || "100", 10);
const NET_RATE_PER_GB_5MIN = parseInt(process.env.NET_RATE_PER_GB_5MIN || "200", 10);

// Prometheus URL
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://prometheus-kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090';

// Thresholds at which to send email alerts (sane defaults):
// descending order, from high to negative.
const BILLING_THRESHOLDS = [
    50000000, 20000000, 10000000, 5000000, 2000000, 1000000,
    500000, 200000, 100000, 50000, 20000, 5000, 1000, 500, 0, -500,
    -2000, -10000, -50000, -100000, -200000, -300000, -400000, -500000,
    -700000, -1000000, -5000000, -10000000, -20000000, -50000000
];

async function queryPrometheus(query: string): Promise<number> {
    const url = `${PROMETHEUS_URL}/api/v1/query`;
    const params = { query };
    const resp = await axios.get(url, { params });
    if (resp.data.status !== 'success') {
        throw new Error(`Prometheus query failed: ${JSON.stringify(resp.data)}`);
    }
    const result = resp.data.data.result;
    if (result.length === 0) {
        return 0;
    }

    const value = parseFloat(result[0].value[1]);
    if (isNaN(value)) return 0;
    return value;
}

/**
 * Determine which thresholds have been crossed going from oldBalance to newBalance.
 * Returns an array of thresholds that have just been crossed downward.
 */
function getCrossedThresholds(oldBalance: number, newBalance: number, alreadyNotified: number[]): number[] {
    // We only care about thresholds that we have not already notified.
    const relevantThresholds = BILLING_THRESHOLDS.filter(t => !alreadyNotified.includes(t));

    // A threshold is crossed if oldBalance >= threshold and newBalance < threshold
    return relevantThresholds.filter(t => oldBalance >= t && newBalance < t);
}

export async function billProjects() {
    const projects = await db('projects').select('*');

    for (const project of projects) {
        const namespace = `cars-project-${project.project_uuid}`;
        const oldBalance = Number(project.balance);

        try {
            // CPU (CPU cores over last 5m): use rate of cpu_usage_seconds_total
            // This gives CPU usage in CPU-seconds/s. Multiplying by 300s (5m) is implicit in rate.
            // The query returns average CPU cores used (since 1 CPU = 1 second/second usage):
            const cpuQuery = `sum(rate(container_cpu_usage_seconds_total{namespace="${namespace}", image!=""}[5m]))`;
            const cpuCores = await queryPrometheus(cpuQuery);

            // Memory (use working set bytes): average over last 5 minutes
            // memory is a gauge, so we can use avg_over_time
            const memQuery = `avg_over_time(container_memory_working_set_bytes{namespace="${namespace}", image!=""}[5m])`;
            const memoryBytes = await queryPrometheus(memQuery);

            // Network (sum of rx+tx over last 5m)
            // Use increase(...) over 5m and sum them
            const netQuery = `sum(increase(container_network_receive_bytes_total{namespace="${namespace}", image!=""}[5m]) + increase(container_network_transmit_bytes_total{namespace="${namespace}", image!=""}[5m]))`;
            const networkBytes = await queryPrometheus(netQuery);

            // Disk usage: If we have PVCs, kubelet_volume_stats_used_bytes will be available.
            // We take average usage over 5m:
            const diskQuery = `avg_over_time(kubelet_volume_stats_used_bytes{namespace="${namespace}"}[5m])`;
            let diskBytes = 0;
            try {
                diskBytes = await queryPrometheus(diskQuery);
            } catch (err) {
                // It's possible no volumes are found. If so, leave diskBytes=0.
                diskBytes = 0;
            }

            // Convert to GB
            const memGB = memoryBytes / (1024 * 1024 * 1024);
            const diskGB = diskBytes / (1024 * 1024 * 1024);
            const netGB = networkBytes / (1024 * 1024 * 1024);

            // CPU cores are already in "cores" not millicores due to rate calculation
            // CPU usage from Prometheus rate is average cores used over the last 5m.

            const cpuCost = Math.ceil(cpuCores * CPU_RATE_PER_CORE_5MIN);
            const memCost = Math.ceil(memGB * MEM_RATE_PER_GB_5MIN);
            const diskCost = Math.ceil(diskGB * DISK_RATE_PER_GB_5MIN);
            const netCost = Math.ceil(netGB * NET_RATE_PER_GB_5MIN);

            const totalCost = cpuCost + memCost + diskCost + netCost;

            if (totalCost > 0) {
                const newBalance = oldBalance - totalCost;
                await db('projects').where({ id: project.id }).update({ balance: newBalance });

                // Insert accounting record
                const metadata = {
                    cpuCost,
                    memCost,
                    diskCost,
                    netCost,
                    rates: {
                        CPU_RATE_PER_CORE_5MIN,
                        MEM_RATE_PER_GB_5MIN,
                        DISK_RATE_PER_GB_5MIN,
                        NET_RATE_PER_GB_5MIN
                    }
                };

                await db('project_accounting').insert({
                    project_id: project.id,
                    type: 'debit',
                    amount_sats: totalCost,
                    balance_after: newBalance,
                    metadata: JSON.stringify(metadata)
                });

                await db('logs').insert({
                    project_id: project.id,
                    message: `Billed ${totalCost} sat (CPU:${cpuCost}, MEM:${memCost}, DISK:${diskCost}, NET:${netCost}) for last 5m. New balance: ${newBalance}`
                });
                logger.info({ project_uuid: project.project_uuid }, `Billed ${totalCost} sat for project (CPU:${cpuCost}, MEM:${memCost}, DISK:${diskCost}, NET:${netCost}). New balance: ${newBalance}`);

                // Check thresholds
                const notifiedThresholds = [];
                const crossed = getCrossedThresholds(oldBalance, newBalance, notifiedThresholds);
                if (crossed.length > 0) {
                    // Send emails for each crossed threshold
                    const admins = await db('project_admins')
                        .join('users', 'users.identity_key', 'project_admins.identity_key')
                        .where({ 'project_admins.project_id': project.id })
                        .select('users.email');
                    const emails = admins.map((a: any) => a.email);

                    for (const threshold of crossed) {
                        await sendThresholdEmail(emails, project, newBalance, threshold);
                        await db('logs').insert({
                            project_id: project.id,
                            message: `Balance alert sent at threshold ${threshold}. Balance: ${newBalance}`
                        });
                        logger.info({ project_uuid: project.project_uuid }, `Sent balance alert at threshold ${threshold}. Balance: ${newBalance}`);
                    }
                }

                // Check if we need to disable ingress (balance < 0)
                if (oldBalance >= 0 && newBalance < 0) {
                    // disable ingress
                    // NOT ACTUALLY DISABLING INGRESS UNTIL PAYMENT IS IMPLEMENTED
                    // await disableIngress(project.project_uuid);
                    // await db('logs').insert({
                    //     project_id: project.id,
                    //     message: `Ingress disabled due to negative balance (${newBalance})`
                    // });
                    // logger.info({ project_uuid: project.project_uuid }, 'Ingress disabled due to negative balance');
                }
            }

        } catch (error: any) {
            logger.error({ project_uuid: project.project_uuid, error: error.message }, 'Failed to bill project');
        }
    }
}

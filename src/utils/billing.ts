import logger from '../logger';
import { sendEmailToAdmins } from './email';
import axios from 'axios';
import db from '../db';

const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://prometheus-kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090';

// Rates in satoshis per 5 minutes
const CPU_RATE_PER_CORE_5MIN = 1000;
const MEM_RATE_PER_GB_5MIN = 500;
const DISK_RATE_PER_GB_5MIN = 100;
const NET_RATE_PER_GB_5MIN = 200;

const ALERT_THRESHOLD = 50000;  // satoshis

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

    // Expecting one result vector. Take the value from the first result.
    const value = parseFloat(result[0].value[1]);
    if (isNaN(value)) return 0;
    return value;
}

export async function billProjects() {
    const projects = await db('projects').select('*');

    for (const project of projects) {
        const namespace = `cars-project-${project.project_uuid}`;

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
                const newBalance = Number(project.balance) - totalCost;
                await db('projects').where({ id: project.id }).update({ balance: newBalance });
                await db('logs').insert({
                    project_id: project.id,
                    message: `Billed ${totalCost} sat (CPU:${cpuCost}, MEM:${memCost}, DISK:${diskCost}, NET:${netCost}) for last 5m. New balance: ${newBalance}`
                });
                logger.info({ project_uuid: project.project_uuid }, `Billed ${totalCost} sat for project. New balance: ${newBalance}`);

                // Check threshold
                if (newBalance < ALERT_THRESHOLD) {
                    const admins = await db('project_admins')
                        .join('users', 'users.identity_key', 'project_admins.identity_key')
                        .where({ 'project_admins.project_id': project.id })
                        .select('users.email');
                    const emails = admins.map((a: any) => a.email);
                    if (emails.length > 0) {
                        await sendEmailToAdmins(emails, project, newBalance);
                        await db('logs').insert({
                            project_id: project.id,
                            message: `Balance alert sent. Balance: ${newBalance} sat`
                        });
                        logger.info({ project_uuid: project.project_uuid }, `Sent balance alert. Balance: ${newBalance}`);
                    }
                }
            }
        } catch (error: any) {
            logger.error({ project_uuid: project.project_uuid, error: error.message }, 'Failed to bill project');
        }
    }
}

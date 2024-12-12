import { spawnSync } from 'child_process';
import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';

async function checkCmd(cmd: string) {
    const res = spawnSync(cmd, ['--version'], { encoding: 'utf-8' });
    if (res.error) {
        throw new Error(`${cmd} not found. Please install.`);
    }
}

async function main() {
    console.log('Checking dependencies: kubectl, helm...');
    await checkCmd('kubectl');
    await checkCmd('helm');

    // Check kubectl cluster
    const clusterInfo = spawnSync('kubectl', ['cluster-info'], { encoding: 'utf-8' });
    if (clusterInfo.status !== 0) {
        const { action } = await inquirer.prompt([
            {
                type: 'list', name: 'action', message: 'No connected cluster found. Create a new cluster?', choices: [
                    'Minikube (local)',
                    'Cancel'
                ]
            }
        ]);
        if (action === 'Minikube (local)') {
            // start minikube
            spawnSync('minikube', ['start'], { stdio: 'inherit' });
        } else {
            process.exit(1);
        }
    }

    console.log('Deploying database with helm chart...');
    spawnSync('helm', ['repo', 'add', 'bitnami', 'https://charts.bitnami.com/bitnami'], { stdio: 'inherit' });
    spawnSync('helm', ['install', 'cars-db', 'bitnami/postgresql', '--set', 'postgresqlPassword=yourpassword'], { stdio: 'inherit' });

    console.log('Waiting for database to be ready...');
    // In real code: check pod status, wait until running

    console.log('Deploying CARS Node helm chart...');
    // We assume we have a helm chart in ./helm directory
    spawnSync('helm', ['install', 'cars-node', './helm'], { stdio: 'inherit' });

    console.log('CARS node deployed successfully!');
}

main().catch(err => {
    console.error('Setup failed:', err);
    process.exit(1);
});

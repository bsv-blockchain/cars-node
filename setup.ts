#!/usr/bin/env ts-node

import * as fs from 'fs';
import * as path from 'path';
import inquirer from 'inquirer';
import axios from 'axios';
import chalk from 'chalk';

/**
 * This script interactively builds a .env file.
 * It prompts the user for config values, offering known defaults,
 * and validates inputs where possible.
 */

interface EnvVarDefinition {
    key: string;
    description?: string;
    default?: string;
    validate?: (val: string) => Promise<boolean> | boolean;
    smartChoices?: { name: string; value: string }[]; // if provided, user can pick a known good default
    mask?: boolean; // if true, input should be password type
}

const ENV_PATH = path.resolve(process.cwd(), '.env');

// Validation functions

async function validateURL(url: string): Promise<boolean> {
    try {
        const res = await axios.get(url, { timeout: 3000 });
        return res.status >= 200 && res.status < 400;
    } catch {
        return false;
    }
}

function validateNonEmpty(val: string): boolean {
    return val.trim().length > 0;
}

async function validateTAALTestnetKey(key: string): Promise<boolean> {
    return key.startsWith('testnet_') && key.length > 10;
}

async function validateTAALMainnetKey(key: string): Promise<boolean> {
    return key.startsWith('mainnet_') && key.length > 10;
}

/**
 * Each entry can have:
 * - key: The .env variable name.
 * - description: What it is used for.
 * - default: A sensible default if applicable.
 * - validate: A function to validate input (if desired).
 * - smartChoices: If you want to present known good defaults for selection.
 * - mask: If true, input will be masked (for sensitive values).
 */

const envVars: EnvVarDefinition[] = [
    {
        key: 'CARS_NODE_PORT',
        description: 'The TCP port on which the CARS Node server will listen.',
        default: '7777',
        validate: (val) => !isNaN(Number(val)) && Number(val) > 0 && Number(val) < 65536,
    },
    {
        key: 'CARS_NODE_SERVER_BASEURL',
        description: 'The base URL of the CARS Node server.',
        default: 'http://localhost:7777',
        validate: (val) => val.startsWith('http')
    },
    {
        key: 'MYSQL_DATABASE',
        description: 'The name of the MySQL database used by the CARS node.',
        default: 'cars_db',
        validate: (val) => val.trim().length > 0
    },
    {
        key: 'MYSQL_USER',
        description: 'The username for the MySQL database.',
        default: 'cars_user',
        validate: (val) => val.trim().length > 0
    },
    {
        key: 'MYSQL_PASSWORD',
        description: 'The password for the MySQL user.',
        default: 'cars_pass',
        mask: true,
        validate: (val) => val.length > 0
    },
    {
        key: 'MYSQL_ROOT_PASSWORD',
        description: 'The root password for the MySQL instance.',
        default: 'rootpassword',
        mask: true,
        validate: (val) => val.length > 0
    },
    {
        key: 'MAINNET_PRIVATE_KEY',
        description: 'The private key used for operations on Bitcoin mainnet.',
        default: '',
        mask: true,
        validate: (val) => val.trim().length === 64
    },
    {
        key: 'TESTNET_PRIVATE_KEY',
        description: 'The private key used for operations on Bitcoin testnet.',
        default: '',
        mask: true,
        validate: (val) => val.trim().length === 64
    },
    {
        key: 'TAAL_API_KEY_MAIN',
        description: 'TAAL API key for mainnet Bitcoin transactions.',
        default: '',
        mask: true,
        validate: (val) => val.startsWith('mainnet_'),
    },
    {
        key: 'TAAL_API_KEY_TEST',
        description: 'TAAL API key for testnet Bitcoin transactions.',
        default: '',
        mask: true,
        validate: (val) => val.startsWith('testnet_'),
    },
    {
        key: 'K3S_TOKEN',
        description: 'Authentication token for the K3S (Kubernetes) cluster.',
        default: 'cars-token',
        mask: true,
        validate: (val) => val.length > 0
    },
    {
        key: 'KUBECONFIG_FILE_PATH',
        description: 'Path to the kubeconfig file used to connect to the Kubernetes cluster.',
        default: '/kubeconfig/kubeconfig.yaml',
        validate: (val) => val.trim().length > 0,
    },
    {
        key: 'DOCKER_HOST',
        description: 'The Docker daemon host address used for building images.',
        default: 'tcp://dind:2375',
        validate: (val) => val.trim().length > 0,
    },
    {
        key: 'DOCKER_REGISTRY',
        description: 'The Docker registry used to store and retrieve images.',
        default: 'cars-registry:5000',
        validate: (val) => val.trim().length > 0,
    },
    {
        key: 'PROJECT_DEPLOYMENT_DNS_NAME',
        description: 'DNS name used for project deployments (e.g., load balancer or ingress host).',
        default: 'localhost',
        validate: (val) => val.trim().length > 0,
    },
    {
        key: 'PROMETHEUS_URL',
        description: 'URL of the Prometheus endpoint for metrics collection.',
        default: 'http://prometheus.localhost:8081',
        validate: (val) => val.startsWith('http'),
    },
    {
        key: 'SENDGRID_API_KEY',
        description: 'SendGrid API key for sending emails.',
        default: '',
        mask: true,
        validate: (val) => val.trim().length > 0,
    },
    {
        key: 'SYSTEM_FROM_EMAIL',
        description: 'The system "from" email address used when sending out emails.',
        default: 'your@email.domain',
        validate: (val) => val.includes('@'),
    },
    {
        key: 'CERT_ISSUANCE_EMAIL',
        description: 'Email address used for certificate issuance (e.g., ACME/Let’s Encrypt).',
        default: 'your@email.domain',
        validate: (val) => val.includes('@'),
    }
];

// Load existing env values if present
let existingEnv: Record<string, string> = {};
if (fs.existsSync(ENV_PATH)) {
    const rawEnv = fs.readFileSync(ENV_PATH, 'utf8');
    rawEnv.split('\n').forEach(line => {
        const [key, ...rest] = line.split('=');
        if (key && rest.length > 0) {
            existingEnv[key] = rest.join('=').replace(/(^"|"$)/g, '');
        }
    });
}

(async () => {
    console.log(chalk.cyanBright('Welcome to the CARS Node Setup Wizard!'));
    console.log(chalk.cyan('This script will guide you through creating or updating your .env configuration.\n'));

    if (Object.keys(existingEnv).length > 0) {
        console.log(chalk.yellow('A .env file already exists. We can update existing values or skip them.\n'));
        const { updateMode } = await inquirer.prompt([
            {
                type: 'list',
                name: 'updateMode',
                message: 'How do you want to proceed?',
                choices: [
                    { name: 'Update only empty or missing values', value: 'missing' },
                    { name: 'Prompt me for all values again (existing values will be used as defaults)', value: 'all' },
                    { name: 'Quit without changes', value: 'quit' },
                ]
            }
        ]);
        if (updateMode === 'quit') {
            console.log(chalk.green('No changes made. Exiting.'));
            process.exit(0);
        }

        // Filter envVars based on mode
        if (updateMode === 'missing') {
            // Only prompt for vars not set or empty in existingEnv
            envVars.forEach(v => {
                if (existingEnv[v.key]) {
                    v.default = existingEnv[v.key];
                }
            });
            // Now filter out those already set (non-empty)
            envVars.forEach((v, idx) => {
                if (existingEnv[v.key] && existingEnv[v.key].trim().length > 0) {
                    // Already set, skip re-prompt
                    (envVars as any)[idx].skip = true;
                }
            });
        } else if (updateMode === 'all') {
            // Use existing values as defaults but re-prompt all
            envVars.forEach(v => {
                if (existingEnv[v.key]) {
                    v.default = existingEnv[v.key];
                }
            });
        }
    }

    const updatedEnv: Record<string, string> = { ...existingEnv };

    for (const variable of envVars) {
        if ((variable as any).skip) continue;

        let finalVal: string = '';
        let defaultValue = variable.default || '';

        if (variable.smartChoices && variable.smartChoices.length > 0) {
            // Offer a choice: pick known defaults or custom
            const { choice } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'choice',
                    message: `Select a value for ${chalk.blue(variable.key)} (${variable.description ?? ''}):`,
                    choices: [...variable.smartChoices, { name: 'Custom value', value: 'custom' }]
                }
            ]);

            if (choice === 'custom') {
                // ask user for custom
                const { val } = await inquirer.prompt([
                    {
                        type: variable.mask ? 'password' : 'input',
                        name: 'val',
                        message: `Enter custom value for ${variable.key}:`,
                        default: defaultValue,
                        validate: variable.validate ? variable.validate : () => true
                    }
                ]);
                finalVal = val;
            } else {
                finalVal = choice;
            }
        } else {
            // Normal input prompt
            const { val } = await inquirer.prompt([
                {
                    type: variable.mask ? 'password' : 'input',
                    name: 'val',
                    message: `Enter a value for ${chalk.blue(variable.key)} (${variable.description ?? ''}):`,
                    default: defaultValue,
                    validate: variable.validate ? variable.validate : () => true
                }
            ]);
            finalVal = val;
        }

        updatedEnv[variable.key] = finalVal.trim();
    }

    // Write updatedEnv to .env file
    const envLines = Object.keys(updatedEnv).map(key => `${key}="${updatedEnv[key]}"`);
    fs.writeFileSync(ENV_PATH, envLines.join('\n') + '\n', 'utf8');

    console.log(chalk.green(`\n✅ Configuration saved to .env!`));
    console.log(`You can now run your CARS node with these settings.\n`);
})();
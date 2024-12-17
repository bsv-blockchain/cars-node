import { Request } from 'express';
import path from 'path';

export type AuthRequest = Request & {
    authrite?: {
        identityKey: string
        certificates: Array<{
            type: string
            certifier: string
            decryptedFields: Record<string, string>
        }>
    }
}

export interface CARSConfigInfo {
    schema: string;
    schemaVersion: string;
    topicManagers?: Record<string, string>;
    lookupServices?: Record<string, { serviceFactory: string; hydrateWith?: string }>;
    frontend?: { language: string; sourceDirectory: string };
    contracts?: { language: string; baseDirectory: string };
    configs?: CARSConfig[];
}

export interface CARSConfig {
    provider: string;
    projectID?: string;
    deploy?: string[];
    network?: string;
}

export function generateIndexTs(info: CARSConfigInfo): string {
    let imports = `
import OverlayExpress from '@bsv/overlay-express'
`;

    let mainFunction = `
const main = async () => {
    const server = new OverlayExpress(
        \`CARS\`,
        process.env.SERVER_PRIVATE_KEY!,
        process.env.HOSTING_URL!
    )

    server.configurePort(8080)
    server.configureVerboseRequestLogging(process.env.REQUEST_LOGGING === 'true')
    server.configureNetwork(process.env.NETWORK === 'mainnet' ? 'main' : 'test')
    await server.configureKnex(process.env.KNEX_URL!)
    await server.configureMongo(process.env.MONGO_URL!)
    server.configureEnableGASPSync(process.env.GASP_SYNC === 'true')
    if (process.env.ARC_API_KEY) {
      server.configureArcApiKey(process.env.ARC_API_KEY!)
    }
    if (process.env.WEB_UI_CONFIG) {
      try {
        server.configureWebUI(JSON.parse(process.env.WEB_UI_CONFIG!))
      } catch (e) {
        console.error('Failed to parse WEB_UI_CONFIG:', e);
      }
    }
`;
    // For each topic manager
    for (const [name, pathToTm] of Object.entries(info.topicManagers || {})) {
        const importName = `tm_${name}`;
        const pathToTmInContainer = pathToTm.replace('/backend', '');
        imports += `import ${importName} from '${pathToTmInContainer}'\n`;
        mainFunction += `    server.configureTopicManager('${name}', new ${importName}())\n`;
    }

    // For each lookup service
    for (const [name, lsConfig] of Object.entries(info.lookupServices || {})) {
        const importName = `lsf_${name}`;
        const pathToLsInContainer = lsConfig.serviceFactory.replace('/backend', '');
        imports += `import ${importName} from '${pathToLsInContainer}'\n`;
        if (lsConfig.hydrateWith === 'mongo') {
            mainFunction += `    server.configureLookupServiceWithMongo('${name}', ${importName})\n`;
        } else if (lsConfig.hydrateWith === 'knex') {
            mainFunction += `    server.configureLookupServiceWithKnex('${name}', ${importName})\n`;
        } else {
            mainFunction += `    server.configureLookupService('${name}', ${importName}())\n`;
        }
    }

    mainFunction += `
    await server.configureEngine()
    await server.start()
}

main()`;

    const indexTsContent = imports + mainFunction;
    return indexTsContent;
}

export function generatePackageJson(backendDependencies: Record<string, string>) {
    const packageJsonContent = {
        "name": "overlay-express-dev",
        "version": "1.0.0",
        "description": "",
        "main": "index.ts",
        "scripts": {
            "start": "tsx index.ts"
        },
        "keywords": [],
        "author": "",
        "license": "ISC",
        "dependencies": {
            ...backendDependencies,
            "@bsv/overlay-express": "^0.1.9",
            "mysql2": "^3.11.5",
            "tsx": "^4.19.2",
            "chalk": "^5.3.0"
        },
        "devDependencies": {
            "@types/node": "^22.10.1"
        }
    };
    return packageJsonContent;
}

export function generateDockerfile(enableContracts: boolean) {
    let file = `FROM node:22-alpine
WORKDIR /app
COPY ./package.json .
RUN npm i
COPY ./index.ts .
COPY ./tsconfig.json .
COPY ./wait-for-services.sh /wait-for-services.sh
RUN chmod +x /wait-for-services.sh`
    if (enableContracts) {
        file += `
COPY ./artifacts ./artifacts`
    }
    file += `
COPY ./src ./src

EXPOSE 8080
CMD ["/wait-for-services.sh", "mysql", "3306", "mongo", "27017", "npm", "run", "start"]`;
    return file;
}

export function generateTsConfig() {
    return `{
    "compilerOptions": {
        "experimentalDecorators": true,
        "emitDecoratorMetadata": true
    }
}`;
}

export function generateWaitScript() {
    return `#!/bin/sh

set -e

host1="$1"
port1="$2"
host2="$3"
port2="$4"
shift 4

echo "Waiting for $host1:$port1..."
while ! nc -z $host1 $port1; do
  sleep 1
done
echo "$host1:$port1 is up"

echo "Waiting for $host2:$port2..."
while ! nc -z $host2 $port2; do
  sleep 1
done
echo "$host2:$port2 is up"

exec "$@"`
}

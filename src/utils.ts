import path from 'path';

/**
 * The shape of the "deployment-info.json" used by CARS
 */
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

/**
 * generateIndexTs:
 * Produces a TypeScript file used as the "main" entrypoint in the
 * OverlayExpress container. We inject environment variables and
 * advanced engine config alignment so that the final server
 * respects the new features (adminBearerToken, sync config, etc.).
 */
export function generateIndexTs(info: CARSConfigInfo): string {
  let imports = `
import OverlayExpress from '@bsv/overlay-express'
`;

  let mainFunction = `
const main = async () => {
  // Construct the OverlayExpress instance, including the admin bearer token if provided:
  const server = new OverlayExpress(
    \`CARS\`,
    process.env.SERVER_PRIVATE_KEY!,
    process.env.HOSTING_URL!,
    process.env.ADMIN_BEARER_TOKEN // 4th param is optional
  );

  // Basic server config
  server.configurePort(8080);
  server.configureVerboseRequestLogging(process.env.REQUEST_LOGGING === 'true');
  server.configureNetwork(process.env.NETWORK === 'mainnet' ? 'main' : 'test');

  // Databases
  await server.configureKnex(process.env.KNEX_URL!);
  await server.configureMongo(process.env.MONGO_URL!);

  // GASP enable/disable
  server.configureEnableGASPSync(process.env.GASP_SYNC === 'true');

  // ARC (TAAL) API key
  if (process.env.ARC_API_KEY) {
    server.configureArcApiKey(process.env.ARC_API_KEY!);
  }

  // If a WebUI config is set, parse it and configure
  if (process.env.WEB_UI_CONFIG) {
    try {
      server.configureWebUI(JSON.parse(process.env.WEB_UI_CONFIG!));
    } catch (e) {
      console.error('Failed to parse WEB_UI_CONFIG:', e);
    }
  }

  // Additional advanced engine config
  const logTime = process.env.LOG_TIME === 'true';
  const logPrefix = process.env.LOG_PREFIX || '[CARS ENGINE] ';
  const throwOnBroadcastFailure = process.env.THROW_ON_BROADCAST_FAIL === 'true';
  let parsedSyncConfig = {};
  if (process.env.SYNC_CONFIG_JSON) {
    try {
      parsedSyncConfig = JSON.parse(process.env.SYNC_CONFIG_JSON);
    } catch(e) {
      console.error('Failed to parse SYNC_CONFIG_JSON:', e);
    }
  }

  // Combine advanced options into EngineConfig
  server.configureEngineParams({
    logTime,
    logPrefix,
    throwOnBroadcastFailure,
    syncConfiguration: parsedSyncConfig
  });
`;

  // For each Topic Manager in the deployment-info.json
  for (const [name, pathToTm] of Object.entries(info.topicManagers || {})) {
    const importName = `tm_${name}`;
    // Adjust path so it’s importable from inside the container
    const pathToTmInContainer = pathToTm.replace('/backend', '');
    imports += `import ${importName} from '${pathToTmInContainer}'\n`;
    mainFunction += `  server.configureTopicManager('${name}', new ${importName}());\n`;
  }

  // For each Lookup Service in the deployment-info.json
  for (const [name, lsConfig] of Object.entries(info.lookupServices || {})) {
    const importName = `lsf_${name}`;
    const pathToLsInContainer = lsConfig.serviceFactory.replace('/backend', '');
    imports += `import ${importName} from '${pathToLsInContainer}'\n`;
    if (lsConfig.hydrateWith === 'mongo') {
      mainFunction += `  server.configureLookupServiceWithMongo('${name}', ${importName});\n`;
    } else if (lsConfig.hydrateWith === 'knex') {
      mainFunction += `  server.configureLookupServiceWithKnex('${name}', ${importName});\n`;
    } else {
      // If neither mongo nor knex is specified, assume a direct factory
      mainFunction += `  server.configureLookupService('${name}', ${importName}());\n`;
    }
  }

  // Conclude
  mainFunction += `
  await server.configureEngine();
  await server.start();
};

main()`;

  // Return the entire file as a string
  return imports + mainFunction;
}

/**
 * generatePackageJson:
 * Produces a minimal package.json so the container can install dependencies
 * (including overlay-express) at build time.
 */
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
      "@bsv/overlay-express": "^0.6.0",
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

/**
 * generateDockerfile:
 * Produces a Dockerfile for building the backend environment
 * with optional contract artifacts if "enableContracts" is true.
 */
export function generateDockerfile(enableContracts: boolean) {
  let file = `FROM docker.io/node:22-alpine
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

/**
 * generateTsConfig:
 * Just a minimal tsconfig enabling decorators as required by overlay.
 */
export function generateTsConfig() {
  return `{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}`;
}

/**
 * generateWaitScript:
 * A script that waits for MySQL and Mongo containers to come up
 * before starting the Node process.
 */
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

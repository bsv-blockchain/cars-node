import { Request, Response } from 'express';
import fs from 'fs-extra';
import path from 'path';
import { Utils, Wallet } from '@bsv/sdk';
import type { Knex } from 'knex';
import { execSync } from 'child_process';
import logger from '../logger';
import {
  CARSConfig,
  CARSConfigInfo,
  generateDockerfile,
  generateIndexTs,
  generatePackageJson,
  generateTsConfig,
  generateWaitScript,
} from '../utils';
import { findBalanceForKey, fundKey } from '../utils/wallet';
import { sendDeploymentFailureEmail } from '../utils/email';

const projectsDomain: string = process.env.PROJECT_DEPLOYMENT_DNS_NAME!;

export default async (req: Request, res: Response) => {
  const { db, mainnetWallet: wallet, testnetWallet }: { db: Knex, mainnetWallet: Wallet, testnetWallet: Wallet } = req as any;
  const { deploymentId, signature } = req.params;

  // Helper function to log steps to DB logs and logger
  async function logStep(message: string, level: 'info' | 'error' = 'info') {
    const logObj = {
      project_id: deploy?.project_id,
      deploy_id: deploy?.id,
      message
    };
    await db('logs').insert(logObj);
    if (level === 'info') {
      logger.info({ deploymentId }, message);
    } else {
      logger.error({ deploymentId }, message);
    }
  }

  // Helper to run commands with error handling
  function runCmd(cmd: string, options: any = {}) {
    try {
      execSync(cmd, { stdio: 'inherit', ...options });
    } catch (err: any) {
      console.error(err);
      throw new Error(`Command failed (${cmd}): ${err.message}`);
    }
  }

  let deploy: any;
  let project: any;

  try {
    // 1) Validate deployment record
    deploy = await db('deploys').where({ deployment_uuid: deploymentId }).first();
    if (!deploy) {
      return res.status(400).json({ error: 'Invalid deploymentId' });
    }

    // 2) Fetch project
    project = await db('projects').where({ id: deploy.project_id }).first();
    if (!project) {
      return res.status(400).json({ error: 'Project not found' });
    }

    // 3) Verify signature
    const { valid } = await wallet.verifySignature({
      data: Utils.toArray(deploymentId, 'hex'),
      signature: Utils.toArray(signature, 'hex'),
      protocolID: [2, 'url signing'],
      keyID: deploymentId,
      counterparty: 'self'
    });

    if (!valid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // 4) Check project balance
    if (project.balance < 1) {
      return res.status(401).json({ error: `Project balance must be at least 1 satoshi to upload a deployment. Current balance: ${project.balance}` });
    }

    // 5) Store file locally
    const filePath = path.join('/tmp', `artifact_${deploymentId}.tgz`);
    fs.writeFileSync(filePath, req.body); // raw data from request
    await db('deploys').where({ id: deploy.id }).update({ file_path: filePath });
    await logStep(`File uploaded successfully, saved to ${filePath}`);

    // 6) Create a working directory for extraction
    const uploadDir = path.join('/tmp', `build_${deploymentId}`);
    fs.ensureDirSync(uploadDir);

    // 7) Extract tarball
    runCmd(`tar -xzf ${filePath} -C ${uploadDir}`);
    await logStep(`Tarball extracted at ${uploadDir}`);

    // 8) Validate deployment-info.json
    const deploymentInfoPath = path.join(uploadDir, 'deployment-info.json');
    if (!fs.existsSync(deploymentInfoPath)) {
      const errMsg = 'deployment-info.json not found in tarball.';
      await logStep(errMsg, 'error');
      return res.status(400).json({ error: errMsg });
    }

    const deploymentInfo: CARSConfigInfo = JSON.parse(
      fs.readFileSync(deploymentInfoPath, 'utf-8')
    );
    if (deploymentInfo.schema !== 'bsv-app') {
      const errMsg = 'Invalid schema in deployment-info.json';
      await logStep(errMsg, 'error');
      return res.status(400).json({ error: errMsg });
    }

    // 9) Check for matching CARS config
    const carsConfig: CARSConfig | undefined = deploymentInfo.configs?.find(
      (c: CARSConfig) =>
        c.provider === 'CARS' && c.projectID === project.project_uuid
    );

    if (!carsConfig || !carsConfig.projectID) {
      const errMsg = 'No matching CARS config or projectID in deployment-info.json';
      await logStep(errMsg, 'error');
      return res.status(400).json({ error: errMsg });
    }

    if (carsConfig.network !== project.network) {
      const errMsg = `Network mismatch: Project is on ${project.network} but deployment config specifies ${carsConfig.network}`;
      await logStep(errMsg, 'error');
      return res.status(400).json({ error: errMsg });
    }

    // 10) Determine whether we are deploying a frontend and/or backend
    const deployTargets = carsConfig.deploy || [];
    const backendEnabled = deployTargets.includes('backend');
    const frontendEnabled = deployTargets.includes('frontend');

    if (!frontendEnabled && !backendEnabled) {
      const errMsg = `No valid deploy targets found (must include "frontend" and/or "backend").`;
      await logStep(errMsg, 'error');
      return res.status(400).json({ error: errMsg });
    }

    // 11) Build/push Docker images
    const registryHost = process.env.DOCKER_REGISTRY || 'cars-registry:5000';
    let backendImage: string | null = null;
    let frontendImage: string | null = null;

    // --- Frontend build/push ---
    if (frontendEnabled) {
      frontendImage = `${registryHost}/cars-project-${project.project_uuid}/frontend:${deploymentId}`;
      await logStep('Building frontend image...');
      const frontendDir = path.join(uploadDir, 'frontend');
      if (!fs.existsSync(frontendDir)) {
        const errMsg = 'Frontend directory not found but frontend deployment requested.';
        await logStep(errMsg, 'error');
        return res.status(400).json({ error: errMsg });
      }

      // Add minimal NGINX configuration for static serving
      fs.writeFileSync(
        path.join(frontendDir, 'nginx.conf'),
        `server {
    listen 80;
    server_name localhost;
    root /usr/share/nginx/html;
    location / {
        try_files $uri /404.html /index.html;
    }
}`
      );

      // Dockerfile for serving static files
      fs.writeFileSync(
        path.join(frontendDir, 'Dockerfile'),
        `FROM docker.io/nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html
EXPOSE 80`
      );

      // Build + push
      runCmd(`buildah build --storage-driver=vfs  --isolation=chroot -t ${frontendImage} .`, { cwd: frontendDir });
      await logStep(`Frontend image built: ${frontendImage}`);
      runCmd(`buildah push --storage-driver=vfs --tls-verify=false ${frontendImage}`, { cwd: frontendDir });
      await logStep(`Frontend image pushed: ${frontendImage}`);
    }

    // --- Backend build/push ---
    if (backendEnabled) {
      backendImage = `${registryHost}/cars-project-${project.project_uuid}/backend:${deploymentId}`;
      await logStep('Building backend image...');
      const backendDir = path.join(uploadDir, 'backend');
      if (!fs.existsSync(backendDir)) {
        const errMsg = 'Backend directory not found but backend deployment requested.';
        await logStep(errMsg, 'error');
        return res.status(400).json({ error: errMsg });
      }

      const backendPackageJsonPath = path.join(backendDir, 'package.json');
      if (!fs.existsSync(backendPackageJsonPath)) {
        const errMsg = 'Backend directory does not contain a package.json file.';
        await logStep(errMsg, 'error');
        return res.status(400).json({ error: errMsg });
      }

      const backendPackageJson = JSON.parse(
        fs.readFileSync(backendPackageJsonPath, 'utf8')
      );

      // Check if sCrypt contract compilation is needed
      let enableContracts = false;
      if (deploymentInfo.contracts && deploymentInfo.contracts.language === 'sCrypt') {
        enableContracts = true;
      } else if (
        deploymentInfo.contracts &&
        deploymentInfo.contracts.language &&
        deploymentInfo.contracts.language !== 'sCrypt'
      ) {
        const errMsg = `BSV Contract language not supported: ${deploymentInfo.contracts.language}`;
        await logStep(errMsg, 'error');
        return res.status(400).json({ error: errMsg });
      }

      // Create supporting files for Docker build
      fs.writeFileSync(
        path.join(backendDir, 'Dockerfile'),
        generateDockerfile(enableContracts)
      );
      fs.writeFileSync(path.join(backendDir, 'wait-for-services.sh'), generateWaitScript());
      fs.writeFileSync(path.join(backendDir, 'tsconfig.json'), generateTsConfig());
      fs.writeFileSync(
        path.join(backendDir, 'package.json'),
        JSON.stringify(generatePackageJson(backendPackageJson.dependencies as Record<string, string>), null, 2)
      );
      fs.writeFileSync(path.join(backendDir, 'index.ts'), generateIndexTs(deploymentInfo));

      // Build + push
      runCmd(`buildah build --root /tmp/buildah-root --runroot /tmp/buildah-run --isolation=chroot  -t ${backendImage} ${backendDir}`);
      await logStep(`Backend image built: ${backendImage}`);
      runCmd(`buildah push ${backendImage}`);
      await logStep(`Backend image pushed: ${backendImage}`);
    }

    // 12) Prepare environment variables
    let webUiConfigObj = {};
    if (project.web_ui_config) {
      try {
        webUiConfigObj = JSON.parse(project.web_ui_config);
      } catch {
        webUiConfigObj = {};
      }
    }

    let engineConfigObj: any = {};
    try {
      engineConfigObj = project.engine_config ? JSON.parse(project.engine_config) : {};
    } catch (e) {
      engineConfigObj = {};
    }

    const gaspSyncEnv = engineConfigObj.gaspSync === true ? 'true' : 'false';
    const requestLoggingEnv = engineConfigObj.requestLogging === true ? 'true' : 'false';
    const syncConfigJson = JSON.stringify(engineConfigObj.syncConfiguration || {});
    const logTimeEnv = engineConfigObj.logTime === true ? 'true' : 'false';
    const logPrefixEnv = typeof engineConfigObj.logPrefix === 'string' ? engineConfigObj.logPrefix : '[CARS OVERLAY ENGINE] ';
    const throwOnBroadcastFailEnv = engineConfigObj.throwOnBroadcastFailure === true ? 'true' : 'false';
    const adminBearerTokenEnv = project.admin_bearer_token || '';

    // 13) Fund project key if it’s too low
    const projectServerPrivateKey = project.private_key;
    const keyBalance = await findBalanceForKey(projectServerPrivateKey, project.network);
    if (keyBalance < 100) {
      try {
        await fundKey(project.network === 'mainnet' ? wallet : testnetWallet, projectServerPrivateKey, 500, project.network);
      } catch (e) {
        logger.error(`Server could not fund a project private key on ${project.network}!`, e)
      }
    }

    // 14) Generate Helm chart
    const helmDir = path.join(uploadDir, 'helm');
    fs.ensureDirSync(helmDir);

    // Chart.yaml
    fs.writeFileSync(
      path.join(helmDir, 'Chart.yaml'),
      `apiVersion: v2
name: cars-project
version: 0.1.0
description: A chart to deploy a CARS project
`
    );

    // We'll create MySQL/Mongo if backendEnabled is true
    const useMySQL = backendEnabled;
    const useMongo = backendEnabled;
    const ingressHost = `${project.project_uuid}.${projectsDomain}`;

    // Values for the chart
    const valuesObj = {
      backendImage,
      frontendImage,
      ingressHostFrontend: `frontend.${ingressHost}`,
      ingressCustomFrontend: project.frontend_custom_domain,
      ingressHostBackend: `backend.${ingressHost}`,
      ingressCustomBackend: project.backend_custom_domain,
      useMySQL,
      useMongo,
      storage: {
        mysqlSize: '20Gi',
        mongoSize: '20Gi',
      },
    };

    fs.writeFileSync(path.join(helmDir, 'values.yaml'), JSON.stringify(valuesObj, null, 2));

    fs.ensureDirSync(path.join(helmDir, 'templates'));

    // _helpers.tpl
    fs.writeFileSync(
      path.join(helmDir, 'templates', '_helpers.tpl'),
      `{{- define "cars-project.fullname" -}}
{{- .Release.Name -}}
{{- end }}
`
    );

    //
    // 14a) Main Deployment for our app (frontend + backend)
    //
    fs.writeFileSync(
      path.join(helmDir, 'templates', 'deployment.yaml'),
      `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "cars-project.fullname" . }}-deployment
  labels:
    app: {{ include "cars-project.fullname" . }}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {{ include "cars-project.fullname" . }}
  template:
    metadata:
      labels:
        app: {{ include "cars-project.fullname" . }}
    spec:
      containers:
      {{- if .Values.backendImage }}
      - name: backend
        image: {{ .Values.backendImage }}
        env:
        - name: SERVER_PRIVATE_KEY
          value: "${projectServerPrivateKey}"
        - name: HOSTING_URL
          value: "{{ .Values.ingressHostBackend }}"
        - name: REQUEST_LOGGING
          value: "${requestLoggingEnv}"
        - name: GASP_SYNC
          value: "${gaspSyncEnv}"
        - name: NETWORK
          value: "${carsConfig.network}"
        - name: ARC_API_KEY
          value: "${project.network === 'mainnet' ? process.env.TAAL_API_KEY_MAIN : process.env.TAAL_API_KEY_TEST}"
        - name: KNEX_URL
          value: "mysql://projectUser:projectPass@mysql:3306/projectdb"
        - name: MONGO_URL
          value: "mongodb://root:rootpassword@mongo:27017/admin"
        - name: WEB_UI_CONFIG
          value: |-
            ${JSON.stringify(webUiConfigObj)}
        - name: ADMIN_BEARER_TOKEN
          value: "${adminBearerTokenEnv}"
        - name: LOG_TIME
          value: "${logTimeEnv}"
        - name: LOG_PREFIX
          value: "${logPrefixEnv}"
        - name: THROW_ON_BROADCAST_FAIL
          value: "${throwOnBroadcastFailEnv}"
        - name: SYNC_CONFIG_JSON
          value: |-
            ${syncConfigJson}
        ports:
        - containerPort: 8080
        resources:
          requests:
            cpu: 100m  
      {{- end }}
      {{- if .Values.frontendImage }}
      - name: frontend
        image: {{ .Values.frontendImage }}
        ports:
        - containerPort: 80
        resources:
          requests:
            cpu: 100m  
      {{- end }}
`
    );

    //
    // 14b) HorizontalPodAutoscaler for our app (frontend + backend)
    //
    fs.writeFileSync(
      path.join(helmDir, 'templates', 'hpa.yaml'),
      `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ include "cars-project.fullname" . }}-deployment
  labels:
    app: {{ include "cars-project.fullname" . }}
spec:
  maxReplicas: 10
  metrics:
  - resource:
      name: cpu
      target:
        averageUtilization: 50
        type: Utilization
    type: Resource
  minReplicas: 1
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ include "cars-project.fullname" . }}-deployment
`
    );

    //
    // 14c) Service for our combined Pod
    //
    fs.writeFileSync(
      path.join(helmDir, 'templates', 'service.yaml'),
      `apiVersion: v1
kind: Service
metadata:
  name: {{ include "cars-project.fullname" . }}-service
  labels:
    app: {{ include "cars-project.fullname" . }}
spec:
  type: ClusterIP
  selector:
    app: {{ include "cars-project.fullname" . }}
  ports:
  {{- if .Values.backendImage }}
  - port: 8080
    targetPort: 8080
    protocol: TCP
    name: backend
  {{- end }}
  {{- if .Values.frontendImage }}
  - port: 80
    targetPort: 80
    protocol: TCP
    name: frontend
  {{- end }}
`
    );

    //
    // 14d) Ingress for both frontend and backend
    //
    let tlsHosts = '';
    if (frontendEnabled) {
      tlsHosts += `      - {{ .Values.ingressHostFrontend }}\n`;
      if (valuesObj.ingressCustomFrontend) {
        tlsHosts += `      - {{ .Values.ingressCustomFrontend }}\n`;
      }
    }
    if (backendEnabled) {
      tlsHosts += `      - {{ .Values.ingressHostBackend }}\n`;
      if (valuesObj.ingressCustomBackend) {
        tlsHosts += `      - {{ .Values.ingressCustomBackend }}\n`;
      }
    }

    // Define www ingress as separate object to ensure certs don't get clobbered
    // If user doesn't have a custom domain this object won't get used later
    let wwwIngressYaml = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "cars-project.fullname" . }}-www
  labels:
    app: {{ include "cars-project.fullname" . }}
    created-by: cars
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-production"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
      - www.{{ .Values.ingressCustomFrontend }}
      secretName: project-${project.project_uuid}-www-tls
  rules:
  - host: www.{{ .Values.ingressHostFrontend }}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: {{ include "cars-project.fullname" . }}-service
            port:
              number: 80
`;


    let ingressYaml = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "cars-project.fullname" . }}-ingress
  labels:
    app: {{ include "cars-project.fullname" . }}
    created-by: cars
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-production"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
${tlsHosts}      secretName: project-${project.project_uuid}-tls
  rules:
`;

    if (frontendEnabled) {
      ingressYaml += `
  - host: {{ .Values.ingressHostFrontend }}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: {{ include "cars-project.fullname" . }}-service
            port:
              number: 80
`;
      if (project.frontend_custom_domain) {
        ingressYaml += `
  - host: {{ .Values.ingressCustomFrontend }}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: {{ include "cars-project.fullname" . }}-service
            port:
              number: 80
  - host: www.{{ .Values.ingressCustomFrontend }}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: {{ include "cars-project.fullname" . }}-service
            port:
              number: 80
`;
      }
    }
    if (backendEnabled) {
      ingressYaml += `
  - host: {{ .Values.ingressHostBackend }}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: {{ include "cars-project.fullname" . }}-service
            port:
              number: 8080
`;
      if (project.backend_custom_domain) {
        ingressYaml += `
  - host: {{ .Values.ingressCustomBackend }}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: {{ include "cars-project.fullname" . }}-service
            port:
              number: 8080
`;
      }
    }

    fs.writeFileSync(
      path.join(helmDir, 'templates', 'ingress.yaml'),
      ingressYaml
    );

    if (valuesObj.ingressCustomFrontend) {
      fs.writeFileSync(
        path.join(helmDir, 'templates', 'www-ingress.yaml'),
	wwwIngressYaml
      );
    }


    //
    // 14e) MySQL: a StatefulSet + Service + PVC (only if useMySQL)
    //
    fs.writeFileSync(
      path.join(helmDir, 'templates', 'mysql-statefulset.yaml'),
      `{{- if .Values.useMySQL }}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
  labels:
    app: mysql
spec:
  selector:
    matchLabels:
      app: mysql
  serviceName: mysql-headless
  replicas: 1
  template:
    metadata:
      labels:
        app: mysql
    spec:
      containers:
        - name: mysql
          image: mysql:8.0
          env:
            - name: MYSQL_ROOT_PASSWORD
              value: "rootpassword"
            - name: MYSQL_DATABASE
              value: "projectdb"
            - name: MYSQL_USER
              value: "projectUser"
            - name: MYSQL_PASSWORD
              value: "projectPass"
            - name: MYSQL_EXTRA_FLAGS
              value: "--innodb_use_native_aio=0"
          ports:
            - containerPort: 3306
          volumeMounts:
            - name: mysql-data
              mountPath: /var/lib/mysql
  volumeClaimTemplates:
    - metadata:
        name: mysql-data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: {{ .Values.storage.mysqlSize | quote }}

---
apiVersion: v1
kind: Service
metadata:
  name: mysql-headless
  labels:
    app: mysql
spec:
  clusterIP: None
  selector:
    app: mysql
  ports:
    - port: 3306
      targetPort: 3306
      protocol: TCP
      name: mysql
---
apiVersion: v1
kind: Service
metadata:
  name: mysql
  labels:
    app: mysql
spec:
  selector:
    app: mysql
  ports:
    - port: 3306
      targetPort: 3306
      protocol: TCP
      name: mysql
{{- end }}
`
    );

    //
    // 14f) MongoDB: a StatefulSet + Service + PVC (only if useMongo)
    //
    fs.writeFileSync(
      path.join(helmDir, 'templates', 'mongo-statefulset.yaml'),
      `{{- if .Values.useMongo }}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mongo
  labels:
    app: mongo
spec:
  serviceName: mongo-headless
  replicas: 1
  selector:
    matchLabels:
      app: mongo
  template:
    metadata:
      labels:
        app: mongo
    spec:
      containers:
        - name: mongo
          image: mongo:6.0
          env:
            - name: MONGO_INITDB_ROOT_USERNAME
              value: "root"
            - name: MONGO_INITDB_ROOT_PASSWORD
              value: "rootpassword"
          ports:
            - containerPort: 27017
          volumeMounts:
            - name: mongo-data
              mountPath: /data/db
  volumeClaimTemplates:
    - metadata:
        name: mongo-data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: {{ .Values.storage.mongoSize | quote }}

---
apiVersion: v1
kind: Service
metadata:
  name: mongo-headless
  labels:
    app: mongo
spec:
  clusterIP: None
  selector:
    app: mongo
  ports:
    - port: 27017
      targetPort: 27017
      protocol: TCP
      name: mongo
---
apiVersion: v1
kind: Service
metadata:
  name: mongo
  labels:
    app: mongo
spec:
  selector:
    app: mongo
  ports:
    - port: 27017
      targetPort: 27017
      protocol: TCP
      name: mongo
{{- end }}
`
    );

    await logStep(`Helm chart generated at ${helmDir}`);

    // 15) Deploy with Helm
    const namespace = `cars-project-${project.project_uuid}`;
    const helmReleaseName = `cars-project-${project.project_uuid.substr(0, 24)}`;

    runCmd(`helm upgrade --install ${helmReleaseName} ${helmDir} --namespace ${namespace} --atomic --create-namespace`);
    await logStep(`Helm release ${helmReleaseName} deployed for project ${project.project_uuid}`);

    // 16) Wait for the main deployment to roll out
    runCmd(`kubectl rollout status deployment/${helmReleaseName}-deployment -n ${namespace}`);
    await logStep(`Project ${project.project_uuid}, release ${deploymentId} rolled out successfully.`);

    // Log final URLs
    if (frontendEnabled) {
      await logStep(`Frontend URL: ${valuesObj.ingressHostFrontend}`);
    }
    if (backendEnabled) {
      await logStep(`Backend URL: ${valuesObj.ingressHostBackend}`);
    }

    // Return success response
    const responseObj: any = {
      message: 'Deployment completed successfully',
    };
    if (frontendEnabled) responseObj.frontendUrl = valuesObj.ingressHostFrontend;
    if (backendEnabled) responseObj.backendUrl = valuesObj.ingressHostBackend;
    if (frontendEnabled && project.frontend_custom_domain) {
      responseObj.frontendCustomDomain = project.frontend_custom_domain;
    }
    if (backendEnabled && project.backend_custom_domain) {
      responseObj.backendCustomDomain = project.backend_custom_domain;
    }

    res.json(responseObj);
  } catch (error: any) {
    // Handle errors gracefully, logging them and returning a 500
    if (deploy && project) {
      await db('logs').insert({
        project_id: project.id,
        deploy_id: deploy.id,
        message: `Error handling upload: ${error.message}`
      });
      logger.error(`Error handling upload: ${error.message}`, { deploymentId });

      // Attempt to email project admins about the failure
      try {
        const admins = await db('project_admins')
          .join('users', 'users.identity_key', 'project_admins.identity_key')
          .where({ 'project_admins.project_id': project.id })
          .select('users.email', 'users.identity_key');
        const emails = admins.map((a: any) => a.email);

        const subject = `Deployment Failure for Project: ${project.name}`;
        const body = `Hello,

A deployment for project "${project.name}" (ID: ${project.project_uuid}) has failed.
Deployment ID: ${deploy.deployment_uuid}

Error Details:
${error.message}

Originated by: ${(req as any).user?.identity_key} (${(req as any).user?.email})

Please check the logs for more details.

Regards,
CARS System`;

        await sendDeploymentFailureEmail(emails, project, body, subject);
      } catch (ignore) {
        // ignore any email-sending errors
      }
    }

    res.status(500).json({ error: `Error handling upload: ${error.message}` });
  }
};

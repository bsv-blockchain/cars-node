import authrite from 'authrite-express'
import express, { Request, Response, NextFunction } from 'express'
import bodyParser from 'body-parser'
import { Utils, ProtoWallet, PrivateKey } from '@bsv/sdk'
import crypto from 'crypto'

type AuthRequest = Request & {
    authrite?: {
        identityKey: string
        certificates: Array<{
            type: string
            certifier: string
            decryptedFields: Record<string, string>
        }>
    }
}

const app = express()
const port = 7777

// Server private key and URL
const TEST_SERVER_PRIVATE_KEY =
    '6dcc124be5f382be631d49ba12f61adbce33a5ac14f6ddee12de25272f943f8b'
const TEST_SERVER_BASEURL = `http://localhost:${port}`

// Initialize a wallet for signing URLs and verifying signatures
const wallet = new ProtoWallet(new PrivateKey(TEST_SERVER_PRIVATE_KEY, 16))

// Data Structures
interface UserRecord {
    [identityKey: string]: string; // identityKey -> email
}

interface ProjectRecord {
    [projectId: string]: {
        admins: string[];
        deploys: string[];
        log: string;
        balance: number;
        deployedAtDomain: string;
    };
}

interface DeployRecord {
    [deploymentId: string]: {
        file: Uint8Array | null;
        log: string;
        creator: string;
        project: string;
    };
}

const users: UserRecord = {}
const projects: ProjectRecord = {}
const deploys: DeployRecord = {}

// Middleware

// Handle JSON body
app.use(bodyParser.json())

// Allow cross-origin requests (CORS)
app.use((req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Headers', '*')
    res.header('Access-Control-Allow-Methods', '*')
    res.header('Access-Control-Expose-Headers', '*')
    res.header('Access-Control-Allow-Private-Network', 'true')
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200)
    }
    next()
})

// Raw body parser for file uploads (tarballs)
app.use('/upload', bodyParser.raw({ type: 'application/octet-stream', limit: '1gb' }))

/**
 * @route POST /upload/:deploymentId/:signature
 * @desc Upload tarball for a given deployment. The URL is signed by the server.
 */
app.post('/upload/:deploymentId/:signature', async (req: Request, res: Response) => {
    console.log(`[${new Date().toISOString()}] Received request to upload file for deploymentId=${req.params.deploymentId}. Checking deployment existence...`)
    const { deploymentId, signature } = req.params

    // Check that the claimed deployment ID exists
    if (!deploys[deploymentId]) {
        console.log(`[${new Date().toISOString()}] Deployment ${deploymentId} not found. Returning error.`)
        return res.status(400).json({ error: 'Invalid deploymentId' })
    }

    console.log(`[${new Date().toISOString()}] Deployment ${deploymentId} found. Verifying signature...`)
    // Verify the signed URL
    try {
        const { valid } = await wallet.verifySignature({
            data: Utils.toArray(deploymentId, 'hex'),
            signature: Utils.toArray(signature, 'hex'),
            protocolID: [2, 'url signing'],
            keyID: deploymentId,
            counterparty: 'self'
        })

        if (!valid) {
            console.log(`[${new Date().toISOString()}] Signature for deployment ${deploymentId} is invalid. Returning 401.`)
            return res.status(401).json({ error: 'Invalid signature' })
        }
    } catch (e) {
        console.log(`[${new Date().toISOString()}] Error verifying signature for deployment ${deploymentId}. Exception: ${e}. Returning 401.`)
        return res.status(401).json({ error: 'Invalid signature' })
    }

    console.log(`[${new Date().toISOString()}] Signature valid for deployment ${deploymentId}. Storing uploaded file...`)

    // Store the uploaded file as a Uint8Array
    deploys[deploymentId].file = new Uint8Array(req.body)

    console.log(`[${new Date().toISOString()}] File stored for deployment ${deploymentId}, size=${deploys[deploymentId].file?.byteLength}. Updating logs.`)

    // Append a log message
    deploys[deploymentId].log += 'File uploaded successfully.\n'

    console.log(`[${new Date().toISOString()}] File upload completed for deployment ${deploymentId}. Responding to client...`)
    res.json({ message: 'File uploaded successfully', size: deploys[deploymentId].file?.byteLength })
})

// Authrite middleware for authentication
app.use(authrite.middleware({
    serverPrivateKey: TEST_SERVER_PRIVATE_KEY,
    baseUrl: TEST_SERVER_BASEURL,
    requestedCertificates: {
        types: {
            'exOl3KM0dIJ04EW5pZgbZmPag6MdJXd3/a1enmUU/BA=': ['email']
        },
        certifiers: ['03285263f06139b66fb27f51cf8a92e9dd007c4c4b83876ad6c3e7028db450a4c2']
    }
}))

// Utility functions

/**
 * Check if a user is registered
 * @param identityKey - The identity key of the user
 */
function isUserRegistered(identityKey: string): boolean {
    return Boolean(users[identityKey])
}

/**
 * Check if a user is admin of a project
 * @param projectId 
 * @param identityKey 
 */
function isUserAdminOfProject(projectId: string, identityKey: string): boolean {
    return projects[projectId]?.admins.includes(identityKey) ?? false
}

/**
 * Ensure the caller is registered and return 401 if not
 */
function requireRegisteredUser(req: AuthRequest, res: Response): boolean {
    console.log(`[${new Date().toISOString()}] Checking if user is registered. identityKey=${req.authrite!.identityKey}`)
    if (!isUserRegistered(req.authrite!.identityKey)) {
        console.log(`[${new Date().toISOString()}] User not registered: ${req.authrite!.identityKey}. Returning 401.`)
        res.status(401).json({ error: 'User not registered. Please register first.' })
        return false
    }
    console.log(`[${new Date().toISOString()}] User is registered: ${req.authrite!.identityKey}`)
    return true
}

/**
 * Ensure the project exists
 */
function requireProjectExists(projectId: string, res: Response): boolean {
    console.log(`[${new Date().toISOString()}] Checking if project exists: ${projectId}`)
    if (!projects[projectId]) {
        console.log(`[${new Date().toISOString()}] Project does not exist: ${projectId}. Returning 404.`)
        res.status(404).json({ error: 'Project does not exist' })
        return false
    }
    console.log(`[${new Date().toISOString()}] Project exists: ${projectId}`)
    return true
}

/**
 * Ensure the caller is admin of the given project
 */
function requireProjectAdmin(projectId: string, identityKey: string, res: Response): boolean {
    console.log(`[${new Date().toISOString()}] Checking if user=${identityKey} is admin of project=${projectId}`)
    if (!isUserAdminOfProject(projectId, identityKey)) {
        console.log(`[${new Date().toISOString()}] User ${identityKey} is not admin of project ${projectId}. Returning 403.`)
        res.status(403).json({ error: 'User is not admin of this project' })
        return false
    }
    console.log(`[${new Date().toISOString()}] User ${identityKey} is admin of project ${projectId}`)
    return true
}

// Routes

/**
 * @route POST /api/v1/register
 * @desc Register a user using Authrite's authenticated certificates.
 *       The user's email is extracted from the Authrite certificate.
 */
app.post('/api/v1/register', (req: AuthRequest, res: Response) => {
    console.log(`[${new Date().toISOString()}] User registration request received. identityKey=${req.authrite!.identityKey}`)
    const email = req.authrite!.certificates[0].decryptedFields.email
    console.log(`[${new Date().toISOString()}] Extracted email from certificate: ${email}`)
    users[req.authrite!.identityKey] = email
    console.log(`[${new Date().toISOString()}] User registered successfully: ${req.authrite!.identityKey}, email=${email}. Current user count=${Object.keys(users).length}`)
    res.json({ message: 'User registered', userCount: Object.keys(users).length })
})

/**
 * @route POST /api/v1/project/create
 * @desc Create a new project and make the caller an admin.
 *       The projectId is auto-generated and returned.
 */
app.post('/api/v1/project/create', (req: AuthRequest, res: Response) => {
    console.log(`[${new Date().toISOString()}] Project creation request from user: ${req.authrite!.identityKey}. Checking if registered...`)
    if (!requireRegisteredUser(req, res)) return

    console.log(`[${new Date().toISOString()}] User is registered. Creating a new project...`)
    const projectId = crypto.randomBytes(16).toString('hex')
    projects[projectId] = {
        admins: [req.authrite!.identityKey],
        deploys: [],
        log: 'Project created\n',
        balance: 0,
        deployedAtDomain: 'domain.com'
    }
    console.log(`[${new Date().toISOString()}] Project created successfully: ${projectId}. User ${req.authrite!.identityKey} set as admin. Returning response.`)
    res.json({ projectId, message: 'Project created' })
})

/**
 * @route POST /api/v1/projects/list
 * @desc List all projects for which the caller is an admin.
 */
app.post('/api/v1/projects/list', (req: AuthRequest, res: Response) => {
    console.log(`[${new Date().toISOString()}] Request to list projects for user: ${req.authrite!.identityKey}`)
    if (!requireRegisteredUser(req, res)) return

    console.log(`[${new Date().toISOString()}] User is registered. Filtering projects where user is admin...`)
    const adminProjects = Object.entries(projects)
        .filter(([_, project]) => project.admins.includes(req.authrite!.identityKey))
        .map(([id]) => id)

    console.log(`[${new Date().toISOString()}] Found projects where user is admin: ${adminProjects.join(', ')}`)
    res.json({ projects: adminProjects })
})

/**
 * @route POST /api/v1/project/:projectId/addAdmin
 * @desc Add an admin to a project. Caller must be admin.
 * @body { identityKey: string }
 */
app.post('/api/v1/project/:projectId/addAdmin', (req: AuthRequest, res: Response) => {
    if (!requireRegisteredUser(req, res)) return
    const { projectId } = req.params
    const { identityKey } = req.body
    console.log(`[${new Date().toISOString()}] Request to add admin to project=${projectId} by user=${req.authrite!.identityKey}. Target identityKey=${identityKey}`)

    if (!requireRegisteredUser(req, res)) return
    if (!requireProjectExists(projectId, res)) return
    if (!requireProjectAdmin(projectId, req.authrite!.identityKey, res)) return

    console.log(`[${new Date().toISOString()}] All conditions met. Checking if target user is registered...`)
    if (!isUserRegistered(identityKey)) {
        console.log(`[${new Date().toISOString()}] Target user ${identityKey} is not registered. Returning 400.`)
        return res.status(400).json({ error: 'User to add as admin is not registered' })
    }

    console.log(`[${new Date().toISOString()}] Target user ${identityKey} is registered. Checking if already admin...`)
    const project = projects[projectId]
    if (!project.admins.includes(identityKey)) {
        project.admins.push(identityKey)
        project.log += `Admin added: ${identityKey}\n`
        console.log(`[${new Date().toISOString()}] Admin ${identityKey} added to project ${projectId}. Updated project record and log.`)
        return res.json({ message: 'Admin added' })
    } else {
        console.log(`[${new Date().toISOString()}] User ${identityKey} is already admin of project ${projectId}. Returning response.`)
        return res.json({ message: 'User is already an admin' })
    }
})

/**
 * @route POST /api/v1/project/:projectId/removeAdmin
 * @desc Remove an admin from a project. Caller must be admin.
 *       Will not allow removing the last admin.
 * @body { identityKey: string }
 */
app.post('/api/v1/project/:projectId/removeAdmin', (req: AuthRequest, res: Response) => {
    if (!requireRegisteredUser(req, res)) return
    const { projectId } = req.params
    const { identityKey } = req.body
    console.log(`[${new Date().toISOString()}] Request to remove admin from project=${projectId} by user=${req.authrite!.identityKey}. Target identityKey=${identityKey}`)

    if (!requireRegisteredUser(req, res)) return
    if (!requireProjectExists(projectId, res)) return
    if (!requireProjectAdmin(projectId, req.authrite!.identityKey, res)) return

    console.log(`[${new Date().toISOString()}] All conditions met. Checking if target user is admin of project ${projectId}...`)
    const project = projects[projectId]
    if (!project.admins.includes(identityKey)) {
        console.log(`[${new Date().toISOString()}] Target user ${identityKey} is not admin of project ${projectId}. Returning 400.`)
        return res.status(400).json({ error: 'User is not an admin of this project' })
    }

    console.log(`[${new Date().toISOString()}] Target user ${identityKey} is admin. Checking if this is the last admin...`)
    if (project.admins.length === 1 && project.admins[0] === identityKey) {
        console.log(`[${new Date().toISOString()}] Attempt to remove the last admin ${identityKey} from project ${projectId}. Returning 400.`)
        return res.status(400).json({ error: 'Cannot remove the last admin' })
    }

    console.log(`[${new Date().toISOString()}] Removing admin ${identityKey} from project ${projectId}...`)
    project.admins = project.admins.filter(a => a !== identityKey)
    project.log += `Admin removed: ${identityKey}\n`
    console.log(`[${new Date().toISOString()}] Admin ${identityKey} removed. Updated project record and logs.`)
    res.json({ message: 'Admin removed' })
})

/**
 * @route POST /api/v1/project/:projectId/admins/list
 * @desc Get a list of all admins for a project if the caller is an admin.
 */
app.post('/api/v1/project/:projectId/admins/list', (req: AuthRequest, res: Response) => {
    const { projectId } = req.params
    console.log(`[${new Date().toISOString()}] Request to list admins for project=${projectId} by user=${req.authrite!.identityKey}`)

    if (!requireRegisteredUser(req, res)) return
    if (!requireProjectExists(projectId, res)) return
    if (!requireProjectAdmin(projectId, req.authrite!.identityKey, res)) return

    console.log(`[${new Date().toISOString()}] User is admin of project ${projectId}. Returning list of admins.`)
    const adminList = projects[projectId].admins
    res.json({ admins: adminList })
})

/**
 * @route POST /api/v1/project/:projectId/deploys/list
 * @desc Get a list of all deployments for a project if user is admin.
 */
app.post('/api/v1/project/:projectId/deploys/list', (req: AuthRequest, res: Response) => {
    const { projectId } = req.params
    console.log(`[${new Date().toISOString()}] Request to list deploys for project=${projectId} by user=${req.authrite!.identityKey}`)

    if (!requireRegisteredUser(req, res)) return
    if (!requireProjectExists(projectId, res)) return
    if (!requireProjectAdmin(projectId, req.authrite!.identityKey, res)) return

    console.log(`[${new Date().toISOString()}] User is admin of project ${projectId}. Returning deploy list: ${projects[projectId].deploys.join(', ')}`)
    res.json({ deploys: projects[projectId].deploys })
})

/**
 * @route POST /api/v1/project/:projectId/logs/show
 * @desc Get the project logs if user is admin.
 */
app.post('/api/v1/project/:projectId/logs/show', (req: AuthRequest, res: Response) => {
    const { projectId } = req.params
    console.log(`[${new Date().toISOString()}] Request to show logs for project=${projectId} by user=${req.authrite!.identityKey}`)

    if (!requireRegisteredUser(req, res)) return
    if (!requireProjectExists(projectId, res)) return
    if (!requireProjectAdmin(projectId, req.authrite!.identityKey, res)) return

    console.log(`[${new Date().toISOString()}] User is admin of project ${projectId}. Returning project logs.`)
    res.json({ logs: projects[projectId].log })
})

/**
 * @route POST /api/v1/deploy/:deploymentId/logs/show
 * @desc Get the deploy logs if user is admin of the associated project.
 */
app.post('/api/v1/deploy/:deploymentId/logs/show', (req: AuthRequest, res: Response) => {
    const { deploymentId } = req.params
    console.log(`[${new Date().toISOString()}] Request to show logs for deployment=${deploymentId} by user=${req.authrite!.identityKey}`)

    if (!requireRegisteredUser(req, res)) return

    console.log(`[${new Date().toISOString()}] Checking if deployment ${deploymentId} exists...`)
    if (!deploys[deploymentId]) {
        console.log(`[${new Date().toISOString()}] Deployment ${deploymentId} not found. Returning 404.`)
        return res.status(404).json({ error: 'Deploy not found' })
    }

    const deploy = deploys[deploymentId]
    console.log(`[${new Date().toISOString()}] Deployment found. Checking if user is admin of associated project ${deploy.project}...`)
    if (!requireProjectAdmin(deploy.project, req.authrite!.identityKey, res)) return

    console.log(`[${new Date().toISOString()}] User is admin of project ${deploy.project}. Returning deploy logs.`)
    res.json({ logs: deploy.log })
})

/**
 * @route POST /api/v1/project/:projectId/deploy
 * @desc Create a new deployment for a project if caller is admin.
 *       Returns a signed URL for file upload.
 */
app.post('/api/v1/project/:projectId/deploy', async (req: AuthRequest, res: Response) => {
    const { projectId } = req.params
    console.log(`[${new Date().toISOString()}] Request to create new deployment for project=${projectId} by user=${req.authrite!.identityKey}`)

    if (!requireRegisteredUser(req, res)) return
    if (!requireProjectExists(projectId, res)) return
    if (!requireProjectAdmin(projectId, req.authrite!.identityKey, res)) return

    console.log(`[${new Date().toISOString()}] User is admin of project ${projectId}. Creating a new deployment...`)
    const deploymentId = crypto.randomBytes(16).toString('hex')
    deploys[deploymentId] = {
        log: 'Deployment started\n',
        creator: req.authrite!.identityKey,
        project: projectId,
        file: null
    }

    console.log(`[${new Date().toISOString()}] Deployment ${deploymentId} created. Adding deployment to project's deploy list.`)
    projects[projectId].deploys.push(deploymentId)

    console.log(`[${new Date().toISOString()}] Signing deployment ID to produce upload URL signature...`)
    const { signature } = await wallet.createSignature({
        data: Utils.toArray(deploymentId, 'hex'),
        protocolID: [2, 'url signing'],
        keyID: deploymentId,
        counterparty: 'self'
    })

    const uploadUrl = `${TEST_SERVER_BASEURL}/upload/${deploymentId}/${Utils.toHex(signature)}`
    console.log(`[${new Date().toISOString()}] Signature generated. Upload URL=${uploadUrl}. Returning response to client.`)
    res.json({
        url: uploadUrl,
        deploymentId,
        message: 'Deployment created. Use the returned URL to upload the project tarball.'
    })
})

app.listen(port, () => {
    console.log(`CARS Node listening on port ${port}`)
})

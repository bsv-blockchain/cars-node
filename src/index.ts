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
    const { deploymentId, signature } = req.params
    // Check that the claimed deployment ID exists
    if (!deploys[deploymentId]) {
        return res.status(400).json({ error: 'Invalid deploymentId' })
    }

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
            return res.status(401).json({ error: 'Invalid signature' })
        }
    } catch (e) {
        return res.status(401).json({ error: 'Invalid signature' })
    }

    // Store the uploaded file as a Uint8Array
    deploys[deploymentId].file = new Uint8Array(req.body)

    // Append a log message
    deploys[deploymentId].log += 'File uploaded successfully.\n'

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
    if (!isUserRegistered(req.authrite!.identityKey)) {
        res.status(401).json({ error: 'User not registered. Please register first.' })
        return false
    }
    return true
}

/**
 * Ensure the project exists
 */
function requireProjectExists(projectId: string, res: Response): boolean {
    if (!projects[projectId]) {
        res.status(404).json({ error: 'Project does not exist' })
        return false
    }
    return true
}

/**
 * Ensure the caller is admin of the given project
 */
function requireProjectAdmin(projectId: string, identityKey: string, res: Response): boolean {
    if (!isUserAdminOfProject(projectId, identityKey)) {
        res.status(403).json({ error: 'User is not admin of this project' })
        return false
    }
    return true
}

// Routes

/**
 * @route POST /api/v1/register
 * @desc Register a user using Authrite's authenticated certificates.
 *       The user's email is extracted from the Authrite cert.
 */
app.post('/api/v1/register', (req: AuthRequest, res: Response) => {
    // Extract email from decrypted certificate fields
    const email = req.authrite!.certificates[0].decryptedFields.email
    users[req.authrite!.identityKey] = email
    res.json({ message: 'User registered', userCount: Object.keys(users).length })
})

/**
 * @route POST /api/v1/project/create
 * @desc Create a new project and make the caller an admin.
 *       The projectId is auto-generated and returned.
 */
app.post('/api/v1/project/create', (req: AuthRequest, res: Response) => {
    if (!requireRegisteredUser(req, res)) return

    const projectId = crypto.randomBytes(16).toString('hex')
    projects[projectId] = {
        admins: [req.authrite!.identityKey],
        deploys: [],
        log: 'Project created\n',
        balance: 0,
        deployedAtDomain: 'domain.com'
    }
    res.json({ projectId, message: 'Project created' })
})

/**
 * @route GET /api/v1/projects
 * @desc List all projects for which the caller is an admin.
 */
app.post('/api/v1/get-projects', (req: AuthRequest, res: Response) => {
    if (!requireRegisteredUser(req, res)) return

    const adminProjects = Object.entries(projects)
        .filter(([_, project]) => project.admins.includes(req.authrite!.identityKey))
        .map(([id]) => id)

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

    if (!requireProjectExists(projectId, res)) return
    if (!requireProjectAdmin(projectId, req.authrite!.identityKey, res)) return

    if (!isUserRegistered(identityKey)) {
        return res.status(400).json({ error: 'User to add as admin is not registered' })
    }

    const project = projects[projectId]
    if (!project.admins.includes(identityKey)) {
        project.admins.push(identityKey)
        project.log += `Admin added: ${identityKey}\n`
        return res.json({ message: 'Admin added' })
    } else {
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

    if (!requireProjectExists(projectId, res)) return
    if (!requireProjectAdmin(projectId, req.authrite!.identityKey, res)) return

    const project = projects[projectId]
    if (!project.admins.includes(identityKey)) {
        return res.status(400).json({ error: 'User is not an admin of this project' })
    }

    if (project.admins.length === 1 && project.admins[0] === identityKey) {
        return res.status(400).json({ error: 'Cannot remove the last admin' })
    }

    project.admins = project.admins.filter(a => a !== identityKey)
    project.log += `Admin removed: ${identityKey}\n`
    res.json({ message: 'Admin removed' })
})

/**
 * @route GET /api/v1/project/:projectId/deploys
 * @desc Get a list of all deployments for a project if user is admin.
 */
app.post('/api/v1/get-project/:projectId/deploys', (req: AuthRequest, res: Response) => {
    if (!requireRegisteredUser(req, res)) return
    const { projectId } = req.params

    if (!requireProjectExists(projectId, res)) return
    if (!requireProjectAdmin(projectId, req.authrite!.identityKey, res)) return

    res.json({ deploys: projects[projectId].deploys })
})

/**
 * @route GET /api/v1/project/:projectId/logs
 * @desc Get the project logs if user is admin.
 */
app.post('/api/v1/get-project/:projectId/logs', (req: AuthRequest, res: Response) => {
    if (!requireRegisteredUser(req, res)) return
    const { projectId } = req.params

    if (!requireProjectExists(projectId, res)) return
    if (!requireProjectAdmin(projectId, req.authrite!.identityKey, res)) return

    res.json({ logs: projects[projectId].log })
})

/**
 * @route POST /api/v1/project/:projectId/logs
 * @desc Append to project logs if user is admin.
 * @body { message: string }
 */
app.post('/api/v1/project/:projectId/logs', (req: AuthRequest, res: Response) => {
    if (!requireRegisteredUser(req, res)) return
    const { projectId } = req.params
    const { message } = req.body

    if (!requireProjectExists(projectId, res)) return
    if (!requireProjectAdmin(projectId, req.authrite!.identityKey, res)) return

    projects[projectId].log += `${new Date().toISOString()} - ${req.authrite!.identityKey}: ${message}\n`
    res.json({ message: 'Log appended' })
})

/**
 * @route GET /api/v1/deploy/:deploymentId/logs
 * @desc Get the deploy logs if user is admin of the associated project.
 */
app.post('/api/v1/get-deploy/:deploymentId/logs', (req: AuthRequest, res: Response) => {
    if (!requireRegisteredUser(req, res)) return
    const { deploymentId } = req.params

    if (!deploys[deploymentId]) {
        return res.status(404).json({ error: 'Deploy not found' })
    }

    const deploy = deploys[deploymentId]

    // Must be admin of the project that this deploy belongs to
    if (!requireProjectAdmin(deploy.project, req.authrite!.identityKey, res)) return

    res.json({ logs: deploy.log })
})

/**
 * @route POST /api/v1/deploy/:deploymentId/logs
 * @desc Append to deploy logs if user is admin of the project.
 * @body { message: string }
 */
app.post('/api/v1/deploy/:deploymentId/logs', (req: AuthRequest, res: Response) => {
    if (!requireRegisteredUser(req, res)) return
    const { deploymentId } = req.params
    const { message } = req.body

    if (!deploys[deploymentId]) {
        return res.status(404).json({ error: 'Deploy not found' })
    }

    const deploy = deploys[deploymentId]

    // Must be admin of the project
    if (!requireProjectAdmin(deploy.project, req.authrite!.identityKey, res)) return

    deploy.log += `${new Date().toISOString()} - ${req.authrite!.identityKey}: ${message}\n`
    res.json({ message: 'Log appended to deploy' })
})

/**
 * @route POST /api/v1/project/:projectId/deploy
 * @desc Create a new deployment for a project if caller is admin.
 *       Returns a signed URL for file upload.
 */
app.post('/api/v1/project/:projectId/deploy', async (req: AuthRequest, res: Response) => {
    if (!requireRegisteredUser(req, res)) return
    const { projectId } = req.params

    if (!requireProjectExists(projectId, res)) return
    if (!requireProjectAdmin(projectId, req.authrite!.identityKey, res)) return

    const deploymentId = crypto.randomBytes(16).toString('hex')
    deploys[deploymentId] = {
        log: 'Deployment started\n',
        creator: req.authrite!.identityKey,
        project: projectId,
        file: null
    }

    // Add this deployment to the project record
    projects[projectId].deploys.push(deploymentId)

    // Sign the deployment ID to produce the upload URL signature
    const { signature } = await wallet.createSignature({
        data: Utils.toArray(deploymentId, 'hex'),
        protocolID: [2, 'url signing'],
        keyID: deploymentId,
        counterparty: 'self'
    })

    res.json({
        url: `${TEST_SERVER_BASEURL}/upload/${deploymentId}/${Utils.toHex(signature)}`,
        deploymentId,
        message: 'Deployment created. Use the returned URL to upload the project tarball.'
    })
})

app.listen(port, () => {
    console.log(`CARS Node listening on port ${port}`)
})

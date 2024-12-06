import authrite from 'authrite-express'
import express from 'express'
import bodyparser from 'body-parser'
import { Utils, ProtoWallet, PrivateKey } from '@bsv/sdk'
import crypto from 'crypto'

const app = express()
const port = 7777

const TEST_SERVER_PRIVATE_KEY =
    '6dcc124be5f382be631d49ba12f61adbce33a5ac14f6ddee12de25272f943f8b'
const TEST_SERVER_BASEURL = `http://localhost:${port}`

const wallet = new ProtoWallet(new PrivateKey(TEST_SERVER_PRIVATE_KEY, 16))

// Record of identity key to email
const users: Record<string, string> = {}

// Record of project ID to project
const projects: Record<string, {
    admins: Array<string>
    deploys: Array<string>
    log: string
    balance: number
    deployedAt: string
}> = {}

// Record of deployment ID to deployment
const deploys: Record<string, {
    file: Uint8Array | null
    log: string
    creator: string
    project: string
}> = {}

app.use(bodyparser.json())
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Headers', '*')
    res.header('Access-Control-Allow-Methods', '*')
    res.header('Access-Control-Expose-Headers', '*')
    res.header('Access-Control-Allow-Private-Network', 'true')
    if (req.method === 'OPTIONS') {
        res.sendStatus(200)
    } else {
        next()
    }
})

// Upload URL itself is not authrite protected
app.post('/upload/:deploymentId/:signature', async (req, res) => {
    // Check claimed deployment ID exists
    // Veify the signed URL
    const { valid } = await wallet.verifySignature({
        data: Utils.toArray(req.params.deploymentId, 'hex'),
        signature: Utils.toArray(req.params.signature, 'hex'),
        protocolID: [2, 'url signing'],
        keyID: req.params.deploymentId,
        counterparty: 'self'
    })
    // TODO
    // Process the file that got uploaded
    // Put the file into the deploys record as a Uint8Array
    // Print a success message and we are done (for now)
})

// Configure the express server to use the authrite middleware
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

// Example Routes
app.post('/api/v1/register', (req, res) => {
    // TODO validate
    users[req.authrite.identityKey] = req.authrite.certificates[0].decryptedFields.email
    res.json({ user: Object.keys(users).length })
})

// TODO: Have all the endpoints
// Create project
// List projects
// Get deploys for project
// Get project logs
// Get deploy logs

// Deploy
app.post('/api/v1/project/:projectId/deploy', async (req, res) => {
    if (!users[req.authrite.identityKey]) {
        return res.status(401).json('register first')
    }
    if (!projects[req.params.projectId]) {
        return res.status(401).json('Bad project')
    }
    if (!projects[req.params.projectId].admins.some(x => x === req.authrite.identityKey)) {
        return res.status(401).json('Youre Not allowed')
    }
    const deploymentId = crypto.randomBytes(16).toString('hex')
    deploys[deploymentId] = {
        log: 'started\n',
        creator: req.authrite.identityKey,
        project: req.params.projectId,
        file: null
    }
    // Sign the deployment ID
    const { signature } = await wallet.createSignature({
        data: Utils.toArray(deploymentId, 'hex'),
        protocolID: [2, 'url signing'],
        keyID: deploymentId,
        counterparty: 'self'
    })
    res.json({
        // Return the upload URL
        url: `${TEST_SERVER_BASEURL}/upload/${deploymentId}/${Utils.toHex(signature)}`
    })
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})
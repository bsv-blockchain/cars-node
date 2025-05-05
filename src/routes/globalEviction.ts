import { Transaction, PushDrop, Utils, ProtoWallet } from '@bsv/sdk'
import logger from '../logger'
import axios from 'axios'
import { getBackendDomain } from './projects'

interface Takedown {
    outpoint: string,
    authority: string,
    authorityRequiredSignatures: number,
    humanReadableMessage: string,
    takedownNumber: string,
    signatures: Array<{
        officerIdentityKey: string,
        officerSignature: string
    }>
}

interface RecognizedAuthority {
    name: string,
    authorityRequiredSignatures: number,
    officerIdentityKeys: string[]
}

/**
 * A route to facilitate global eviction of an outpoint from this CARS node.
 */
export default async (req, res) => {
    try {
        const recognizedAuthorities: Array<RecognizedAuthority> = JSON.parse(
            process.env.RECOGNIZED_TAKEDOWN_AUTHORITIES as string || '[]'
        )
        const beef = Array.from(req.body as number[])
        const tx = Transaction.fromBEEF(beef)
        // Make sure the takedown notice is actually on chain.
        await tx.verify()
        const { fields: [json] } = PushDrop.decode(tx.outputs[0].lockingScript)
        const takedown: Takedown = JSON.parse(Utils.toUTF8(json))
        const actionable = recognizedAuthorities.some(x => x.name === takedown.authority && x.authorityRequiredSignatures === takedown.authorityRequiredSignatures)
        if (!actionable) {
            return res.status(400).json({ error: `Not actioned.` })
        }
        const anyoneWallet = new ProtoWallet('anyone')
        const messageForVerification = Utils.toArray(`${takedown.authority}\n${takedown.outpoint}\n${takedown.takedownNumber}\n${takedown.humanReadableMessage}`, 'utf8')
        let gatheredSignatures = 0
        for (let i = 0; i < takedown.signatures.length; i++) {
            try {
                const { valid } = await anyoneWallet.verifySignature({
                    protocolID: [2, 'takedown'],
                    keyID: takedown.takedownNumber,
                    data: messageForVerification,
                    counterparty: takedown.signatures[i].officerIdentityKey,
                    signature: Utils.toArray(takedown.signatures[i].officerSignature, 'hex')
                })
                if (!valid) {
                    continue
                } else {
                    gatheredSignatures++
                }
            } finally {
                continue
            }
        }
        if (gatheredSignatures < takedown.authorityRequiredSignatures) {
            return res.status(400).json({ error: `Not actioned.` })
        }
        const [txid, outputIndexString] = takedown.outpoint.split('.')
        const outputIndex = parseInt(outputIndexString)

        // get all projects
        const projects = await req.db('projects').select('*')
        for (const project of projects) {
            const backendDomain = getBackendDomain(project);
            const url = `https://${backendDomain}/admin/evictOutpoint`;
            try {
                const response = await axios.post(url, {
                    txid,
                    outputIndex
                }, {
                    headers: {
                        Authorization: `Bearer ${project.admin_bearer_token}`
                    },
                    timeout: 120000
                });
                console.log(response.data)
            } finally {
                continue
            }
        }
        res.status(200).json({ message: 'Actioned.' })
    } catch (e) {
        logger.error('Error with takedown request', e)
        res.status(400).json({ error: 'Error with takedown request, not actioned.' })
    }
}

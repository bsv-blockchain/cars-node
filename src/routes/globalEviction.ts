import { Transaction, PushDrop, Utils, ProtoWallet } from '@bsv/sdk'
import logger from '../logger'

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
    officerPublicKeys: string[]
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
            return res.status(400).json({
                error: `This system does not recognize authority ${takedown.authority} with ${takedown.authorityRequiredSignatures} required ${takedown.authorityRequiredSignatures === 1 ? 'signature' : 'signatures'}. Not actioned.`
            })
        }
        const anyoneWallet = new ProtoWallet('anyone')
        const messageForVerification = Utils.toArray(`${takedown.authority}\n${takedown.outpoint}\n${takedown.humanReadableMessage}`, 'utf8')
        let gatheredSignatures = 0
        for (let i = 0; i < takedown.signatures.length; i++) {
            try {
                const { valid } = anyoneWallet.verifySignature({
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
            return res.status(400).json({
                error: `Authority ${takedown.authority} has ${takedown.authorityRequiredSignatures} requires ${takedown.authorityRequiredSignatures === 1 ? 'signature' : 'signatures'}, but only ${gatheredSignatures} valid ${gatheredSignatures === 1 ? 'signature is' : 'signatures are'} present. Not actioned.`
            })
        }

        // Now, we know we can action the takedown request.
        // For every project, for every service, for every topic, delete the outpoint.
        // TODO: Implement this. But there are three nested for loops, we should find a better way.
        // The goal is to remove this outpoint EVERYWHERE it may appear in our system, without making it complex for regulators.
        // We don't want regulators to have to specify specific topic or lookup service names, just point to an outpoint and purge it fully.
        // Within CARS, we just have to find the best and smartest way to do that.
    } catch (e) {
        logger.error('Error with takedown request', e)
        res.status(400).json({ error: 'Error with takedown request, not actioned.' })
    }
}

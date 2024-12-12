import { Request } from 'express';

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

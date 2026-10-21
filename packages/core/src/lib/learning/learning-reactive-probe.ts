import {z} from 'zod'
export const ReactiveProbeInput=z.object({messageId:z.string().regex(/^[a-f0-9]{64}$/),requestId:z.string().uuid()})

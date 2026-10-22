import { wireHTTP } from '#pikku/http'
import { rpcCaller } from '../rpc.js'

wireHTTP({ route: '/rpc/:rpcName', method: 'post', auth: false, func: rpcCaller })

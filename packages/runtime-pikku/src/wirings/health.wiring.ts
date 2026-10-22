import { wireHTTP } from '#pikku/http'
import { learnerHealth } from '../health.js'

wireHTTP({ route: '/api/health', method: 'get', auth: false, func: learnerHealth })

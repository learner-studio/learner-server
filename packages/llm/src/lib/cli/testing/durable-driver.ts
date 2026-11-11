// A worker stand-in for durable-cli-call tests: runs one durable call in `dir` and prints its stdout; the test
// kills this process mid-call the way a restart kills the worker.   bun durable-driver.ts <dir>
import { runDurableCliCall } from '../durable-cli-call.js'
const out = await runDurableCliCall(process.argv[2]!, { agentId: 'codex', prompt: 'grade this', timeoutSec: 60 }, { pollMs: 20 })
console.log(JSON.stringify(out.stdout))

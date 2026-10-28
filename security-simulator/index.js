const crypto = require('crypto')
const path = require('path')

// Node 22 can load the project's ignored local configuration directly. This
// keeps the simulator and proxy on the same simulation token and secrets.
try {
    process.loadEnvFile(path.resolve(__dirname, '../.env'))
} catch (error) {
    if (error.code !== 'ENOENT') throw error
}

const scenario = process.argv[2]
const targetUrl = process.env.TARGET_URL
const simulationToken = process.env.SECURITY_SIMULATION_TOKEN
const maxRequests = positiveNumber('SIMULATION_MAX_REQUESTS', 120)
const timeoutMs = positiveNumber('SIMULATION_TIMEOUT_MS', 15000)

if (!['path-scan', 'brute-force', 'http-flood', 'replay'].includes(scenario)) fail('Usage: node security-simulator/index.js <path-scan|brute-force|http-flood|replay>')
if (process.env.SIMULATION_MODE !== 'true') fail('SIMULATION_MODE=true is required')
if (!targetUrl || !simulationToken) fail('TARGET_URL and SECURITY_SIMULATION_TOKEN are required')

const target = new URL(targetUrl)
if (!isAuthorizedTarget(target)) fail('TARGET_URL must be localhost, a loopback IP, or listed in AUTHORIZED_SIMULATION_TARGETS')

const commonHeaders = { 'x-security-simulation-token': simulationToken }
const startedAt = Date.now()
const responses = new Map()

async function main() {
    console.log(`Running ${scenario} against ${target.origin}`)
    console.log(`Maximum requests: ${maxRequests}; timeout: ${timeoutMs}ms`)
    console.log('Expected result: the proxy returns the scenario-specific rejection or response and records one incident.')
    const since = Date.now()
    if (scenario === 'path-scan') await pathScan()
    if (scenario === 'brute-force') await bruteForce()
    if (scenario === 'http-flood') await httpFlood()
    if (scenario === 'replay') await replay()
    const type = { 'path-scan': 'PATH_SCANNING', 'brute-force': 'BRUTE_FORCE', 'http-flood': 'HTTP_FLOOD', replay: 'REPLAY_ATTACK' }[scenario]
    const incident = await waitForIncident(type, since)
    console.log(`Responses: ${JSON.stringify(Object.fromEntries(responses))}`)
    console.log(`Detected incident: ${incident.incident_id} (${incident.type}, ${incident.rule_id})`)
}

async function pathScan() {
    const count = positiveNumber('SIMULATION_PATH_REQUESTS', 30)
    requireBounded(count)
    for (let index = 0; index < count; index += 1) await request(`/__security/probe/path-${index}`)
}

async function bruteForce() {
    const count = positiveNumber('SIMULATION_LOGIN_FAILURES', 10)
    requireBounded(count)
    for (let index = 0; index < count; index += 1) {
        await request('/__security/demo-login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'demo-user', password: `incorrect-${index}` })
        })
    }
}

async function httpFlood() {
    const count = positiveNumber('SIMULATION_FLOOD_REQUESTS', 105)
    requireBounded(count)
    for (let index = 0; index < count; index += 1) await request('/__security/probe/rate')
}

async function replay() {
    const secret = process.env.SECURITY_WEBHOOK_HMAC_SECRET
    if (!secret) fail('SECURITY_WEBHOOK_HMAC_SECRET is required for the replay scenario')
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = crypto.randomBytes(16).toString('hex')
    const body = JSON.stringify({ event: 'simulation', id: crypto.randomUUID() })
    const signature = `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${nonce}.`).update(body).digest('hex')}`
    const options = {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-security-timestamp': timestamp,
            'x-security-nonce': nonce,
            'x-security-signature': signature
        },
        body
    }
    const first = await request('/__security/demo-webhook', options)
    const second = await request('/__security/demo-webhook', options)
    if (first.status !== 202 || second.status !== 409) fail(`Replay verification failed: expected 202 then 409, got ${first.status} then ${second.status}`)
}

async function request(route, options = {}) {
    if (Date.now() - startedAt > timeoutMs) fail('Simulation timed out')
    const response = await fetch(new URL(route, target), {
        ...options,
        headers: { ...commonHeaders, ...(options.headers || {}) },
        signal: AbortSignal.timeout(Math.max(1000, timeoutMs - (Date.now() - startedAt)))
    })
    responses.set(response.status, (responses.get(response.status) || 0) + 1)
    return response
}

async function waitForIncident(type, since) {
    const deadline = Date.now() + Math.min(timeoutMs, 5000)
    while (Date.now() < deadline) {
        const response = await request(`/__security/incidents?type=${encodeURIComponent(type)}&since=${since}`)
        if (response.ok) {
            const body = await response.json()
            if (body.incidents?.length) return body.incidents[0]
        }
        await new Promise(resolve => setTimeout(resolve, 150))
    }
    fail(`No ${type} incident was recorded before the timeout`)
}

function isAuthorizedTarget(url) {
    if (['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return true
    const authorized = String(process.env.AUTHORIZED_SIMULATION_TARGETS || '').split(',').map(value => value.trim()).filter(Boolean)
    return authorized.includes(url.origin)
}

function positiveNumber(name, fallback) {
    const value = Number(process.env[name] || fallback)
    if (!Number.isInteger(value) || value < 1) fail(`${name} must be a positive integer`)
    return value
}

function requireBounded(count) {
    if (count > maxRequests) fail(`Scenario needs ${count} requests but SIMULATION_MAX_REQUESTS is ${maxRequests}`)
}

function fail(message) {
    console.error(`Simulation failed: ${message}`)
    process.exitCode = 1
    throw new Error(message)
}

main().catch(error => {
    if (!process.exitCode) {
        console.error(`Simulation failed: ${error.message}`)
        process.exitCode = 1
    }
})

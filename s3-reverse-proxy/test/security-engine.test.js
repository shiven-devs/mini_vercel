const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const http = require('node:http')
const test = require('node:test')

const { MemorySecurityState, SecurityEngine } = require('../security/engine')
const { sanitizeRequestPath } = require('../security/request')
const { createApp } = require('../index')

function testConfig(overrides = {}) {
    return {
        pathWindowSeconds: 10,
        pathWindowMs: 10000,
        pathUniqueThreshold: 3,
        pathMinRequests: 3,
        pathNotFoundRatio: 0.6,
        bruteForceWindowSeconds: 60,
        bruteForceWindowMs: 60000,
        bruteForceFailureThreshold: 3,
        rateWindowSeconds: 10,
        rateWindowMs: 10000,
        rateMaxRequests: 3,
        alertCooldownMs: 1000,
        replayNonceTtlSeconds: 300,
        replayNonceTtlMs: 300000,
        allowedHostSuffix: 'localhost',
        trustedProxyIps: [],
        defaultProjectId: 'default-project',
        demoProjectId: 'security-demo',
        demoEndpointsEnabled: true,
        simulationMode: true,
        simulationToken: 'test-simulation-token',
        demoLoginUsername: 'demo-user',
        demoLoginPassword: 'demo-password',
        webhookSecret: 'test-webhook-secret',
        ...overrides
    }
}

function event(index, overrides = {}) {
    return {
        event_id: `event-${index}`,
        source_ip: '127.0.0.1',
        project_id: 'security-demo',
        hostname: 'security-demo.localhost',
        request_path: `/harmless-${index}`,
        response_status: 404,
        ...overrides
    }
}

function engineWithMemory(config = testConfig()) {
    const state = new MemorySecurityState()
    const engine = new SecurityEngine({ state, config, logger: { error() {} } })
    return { state, engine }
}

test('path scanning triggers only at the configured boundary and deduplicates incidents', async () => {
    const { engine } = engineWithMemory()
    await engine.observeRequest(event(1))
    await engine.observeRequest(event(2))
    assert.equal((await engine.listIncidents('PATH_SCANNING', 0)).length, 0)
    await engine.observeRequest(event(3))
    assert.equal((await engine.listIncidents('PATH_SCANNING', 0)).length, 1)
    await engine.observeRequest(event(4))
    assert.equal((await engine.listIncidents('PATH_SCANNING', 0)).length, 1)
})

test('repeated valid paths do not trigger path scanning', async () => {
    const { engine } = engineWithMemory()
    for (let index = 0; index < 5; index += 1) await engine.observeRequest(event(index, { request_path: '/', response_status: 200 }))
    assert.equal((await engine.listIncidents('PATH_SCANNING', 0)).length, 0)
})

test('brute-force records failed authentication only and has a boundary', async () => {
    const { engine } = engineWithMemory()
    await engine.recordLoginAttempt(event(1), true)
    await engine.recordLoginAttempt(event(2), false)
    await engine.recordLoginAttempt(event(3), false)
    assert.equal((await engine.listIncidents('BRUTE_FORCE', 0)).length, 0)
    await engine.recordLoginAttempt(event(4), false)
    assert.equal((await engine.listIncidents('BRUTE_FORCE', 0)).length, 1)
})

test('rate limiting rejects the request above the configured boundary and creates an incident', async () => {
    const { engine } = engineWithMemory()
    for (let index = 0; index < 3; index += 1) assert.equal((await engine.consumeRateLimit(event(index))).allowed, true)
    const rejected = await engine.consumeRateLimit(event(4))
    assert.equal(rejected.allowed, false)
    assert.equal((await engine.listIncidents('HTTP_FLOOD', 0)).length, 1)
})

test('replay nonce reservation is atomic and creates one replay incident', async () => {
    const { engine } = engineWithMemory()
    const attempts = await Promise.all(Array.from({ length: 5 }, () => engine.reserveWebhookNonce(event(1), 'nonce-1234567890abcd')))
    assert.equal(attempts.filter(attempt => attempt.accepted).length, 1)
    assert.equal((await engine.listIncidents('REPLAY_ATTACK', 0)).length, 1)
})

test('sliding-window state expires', async () => {
    let current = 1000
    const state = new MemorySecurityState(() => current)
    await state.recordScan('ip', event(1), 100)
    current += 101
    const metrics = await state.recordScan('ip', event(2), 100)
    assert.equal(metrics.requestCount, 1)
})

test('sensitive query parameters are redacted', () => {
    assert.equal(sanitizeRequestPath('/login?token=secret&view=public&password=hidden'), '/login?token=%5BREDACTED%5D&view=public&password=%5BREDACTED%5D')
})

test('Redis outages fail open for rate limiting without crashing', async () => {
    const state = { consumeRateLimit: async () => { throw new Error('offline') } }
    const engine = new SecurityEngine({ state, config: testConfig(), logger: { error() {} } })
    const result = await engine.consumeRateLimit(event(1))
    assert.equal(result.allowed, true)
    assert.equal(result.unavailable, true)
})

test('isolated demo routes reject invalid signatures and record no credentials in request events', async t => {
    const { state, engine } = engineWithMemory()
    const { app } = createApp({ env: { S3_OUTPUT_BASE_URL: 'http://example.test' }, engine, config: testConfig(), logger: { error() {} } })
    const server = http.createServer(app)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const base = `http://127.0.0.1:${server.address().port}`
    const headers = { 'x-security-simulation-token': 'test-simulation-token' }
    const malformed = await fetch(`${base}/__security/demo-login`, { method: 'POST', headers })
    assert.equal(malformed.status, 400)
    const login = await fetch(`${base}/__security/demo-login`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'demo-user', password: 'do-not-log-me' }) })
    assert.equal(login.status, 401)
    const invalidWebhook = await fetch(`${base}/__security/demo-webhook`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-security-timestamp': String(Math.floor(Date.now() / 1000)), 'x-security-nonce': 'nonce-1234567890abcd', 'x-security-signature': 'sha256=invalid' }, body: '{"test":true}' })
    assert.equal(invalidWebhook.status, 401)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(JSON.stringify(state.requests).includes('do-not-log-me'), false)
})

test('proxy middleware returns 429 after the configured request-rate limit', async t => {
    const config = testConfig({ rateMaxRequests: 1 })
    const { engine } = engineWithMemory(config)
    const { app } = createApp({ env: { S3_OUTPUT_BASE_URL: 'http://example.test' }, engine, config, logger: { error() {} } })
    const server = http.createServer(app)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const base = `http://127.0.0.1:${server.address().port}`
    const headers = { 'x-security-simulation-token': 'test-simulation-token' }
    assert.equal((await fetch(`${base}/__security/probe/first`, { headers })).status, 404)
    const response = await fetch(`${base}/__security/probe/second`, { headers })
    assert.equal(response.status, 429)
    assert.match(response.headers.get('retry-after'), /^\d+$/)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal((await engine.listIncidents('HTTP_FLOOD', 0)).length, 1)
})

test('proxy errors are returned as 502 and recorded as one failed request event', async t => {
    const { state, engine } = engineWithMemory()
    const { app } = createApp({ env: { S3_OUTPUT_BASE_URL: 'http://127.0.0.1:1' }, engine, config: testConfig(), logger: { error() {} } })
    const server = http.createServer(app)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const status = await new Promise((resolve, reject) => {
        const request = http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/', headers: { host: 'demo.localhost' } }, response => {
            response.resume()
            response.on('end', () => resolve(response.statusCode))
        })
        request.on('error', reject)
    })
    assert.equal(status, 502)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(state.requests.length, 1)
    assert.equal(state.requests[0].proxy_error, true)
    assert.equal(state.requests[0].response_status, 502)
})

test('proxy maps a deployment root request to its S3 index.html object', async t => {
    const upstream = http.createServer((req, res) => {
        res.setHeader('content-type', 'text/plain')
        res.end(req.url)
    })
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
    t.after(() => upstream.close())
    const { engine } = engineWithMemory()
    const { app } = createApp({
        env: { S3_OUTPUT_BASE_URL: `http://127.0.0.1:${upstream.address().port}/__outputs` },
        engine,
        config: testConfig(),
        logger: { error() {} }
    })
    const proxyServer = http.createServer(app)
    await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve))
    t.after(() => proxyServer.close())
    const response = await new Promise((resolve, reject) => {
        const request = http.get({ hostname: '127.0.0.1', port: proxyServer.address().port, path: '/', headers: { host: 'demo.localhost' } }, response => {
            let body = ''
            response.on('data', chunk => { body += chunk })
            response.on('end', () => resolve({ status: response.statusCode, body }))
        })
        request.on('error', reject)
    })
    assert.equal(response.status, 200)
    assert.equal(response.body, '/__outputs/demo/index.html')
})

test('demo webhook accepts once, rejects replay, and rejects stale timestamps', async t => {
    const { engine } = engineWithMemory()
    const { app } = createApp({ env: { S3_OUTPUT_BASE_URL: 'http://example.test' }, engine, config: testConfig(), logger: { error() {} } })
    const server = http.createServer(app)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const base = `http://127.0.0.1:${server.address().port}`
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = 'nonce-abcdefghijklmnop'
    const body = '{"event":"demo"}'
    const signature = `sha256=${crypto.createHmac('sha256', 'test-webhook-secret').update(`${timestamp}.${nonce}.`).update(body).digest('hex')}`
    const headers = { 'x-security-simulation-token': 'test-simulation-token', 'content-type': 'application/json', 'x-security-timestamp': timestamp, 'x-security-nonce': nonce, 'x-security-signature': signature }
    assert.equal((await fetch(`${base}/__security/demo-webhook`, { method: 'POST', headers, body })).status, 202)
    assert.equal((await fetch(`${base}/__security/demo-webhook`, { method: 'POST', headers, body })).status, 409)
    const staleHeaders = { ...headers, 'x-security-timestamp': String(Math.floor(Date.now() / 1000) - 1000) }
    assert.equal((await fetch(`${base}/__security/demo-webhook`, { method: 'POST', headers: staleHeaders, body })).status, 401)
})

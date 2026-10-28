const crypto = require('crypto')
const express = require('express')
const httpProxy = require('http-proxy')
const path = require('path')
const Redis = require('ioredis')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })

const { RedisSecurityState, SecurityEngine } = require('./security/engine')
const { loadSecurityConfig } = require('./security/config')
const { requestContext, projectFromHostname, safeEqual } = require('./security/request')

function createSecurityEngine({ env = process.env, redis, logger = console } = {}) {
    const config = loadSecurityConfig(env)
    if (!redis && !env.REDIS_URL) throw new Error('REDIS_URL environment variable is required')
    const client = redis || new Redis(env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1 })
    client.on('error', error => logger.error('Redis security connection error', { message: error.message }))
    const state = new RedisSecurityState(client, {
        requestStreamMaxLen: config.streamMaxLen,
        incidentStreamMaxLen: config.streamMaxLen
    })
    return { engine: new SecurityEngine({ state, config, logger }), config, redis: client }
}

function createApp({ env = process.env, engine: suppliedEngine, config: suppliedConfig, logger = console } = {}) {
    const app = express()
    const config = suppliedConfig || loadSecurityConfig(env)
    const engine = suppliedEngine || createSecurityEngine({ env, logger }).engine
    const basePath = env.S3_OUTPUT_BASE_URL
    if (!basePath) throw new Error('S3_OUTPUT_BASE_URL environment variable is required')
    const proxy = httpProxy.createProxy()
    const demoAllowed = config.demoEndpointsEnabled && config.simulationMode

    proxy.on('error', (error, req, res) => {
        logger.error('Reverse proxy error', { message: error.message, request_id: req.__securityContext?.request_id })
        req.__securityProxyError = true
        if (!res.headersSent) res.statusCode = 502
        if (!res.writableEnded) res.end('Bad gateway')
    })

    app.use(async (req, res, next) => {
        const context = requestContext(req, config)
        req.__securityContext = context
        const startedAt = process.hrtime.bigint()
        let finalized = false
        let responseBytes = 0
        const originalWrite = res.write.bind(res)
        const originalEnd = res.end.bind(res)
        res.write = (chunk, ...args) => {
            if (chunk) responseBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))
            return originalWrite(chunk, ...args)
        }
        res.end = (chunk, ...args) => {
            if (chunk) responseBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))
            return originalEnd(chunk, ...args)
        }
        const finalize = (aborted = false) => {
            if (finalized) return
            finalized = true
            const status = aborted ? 499 : res.statusCode
            const contentLength = Number(res.getHeader('content-length'))
            const event = {
                ...context,
                response_status: Number.isInteger(status) ? status : 500,
                response_bytes: Number.isFinite(contentLength) ? contentLength : responseBytes,
                duration_ms: Number((process.hrtime.bigint() - startedAt) / 1000000n),
                aborted,
                proxy_error: Boolean(req.__securityProxyError)
            }
            void engine.observeRequest(event)
        }
        res.on('finish', () => finalize(false))
        req.on('aborted', () => finalize(true))

        const isAuthorizedSimulationRead = demoAllowed &&
            req.method === 'GET' &&
            req.path === '/__security/incidents' &&
            config.simulationToken &&
            safeEqual(req.headers['x-security-simulation-token'], config.simulationToken)
        const rate = isAuthorizedSimulationRead
            ? { allowed: true, retryAfterSeconds: 0 }
            : await engine.consumeRateLimit(context)
        res.setHeader('X-Request-Id', context.request_id)
        if (!rate.allowed) {
            res.setHeader('Retry-After', String(rate.retryAfterSeconds))
            return res.status(429).json({ error: 'Too many requests', request_id: context.request_id })
        }
        next()
    })

    function requireDemoAccess(req, res, next) {
        if (!demoAllowed || !config.simulationToken) return res.sendStatus(404)
        if (!safeEqual(req.headers['x-security-simulation-token'], config.simulationToken)) return res.sendStatus(403)
        next()
    }

    app.get('/__security/probe/:name', requireDemoAccess, (req, res) => {
        res.status(404).json({ error: 'Harmless simulation probe' })
    })
    app.post('/__security/demo-login', requireDemoAccess, express.json({ limit: '4kb' }), async (req, res) => {
        if (!config.demoLoginPassword || typeof req.body?.username !== 'string' || typeof req.body?.password !== 'string') {
            return res.status(400).json({ error: 'Malformed demo login request' })
        }
        const success = safeEqual(req.body.username, config.demoLoginUsername) && safeEqual(req.body.password, config.demoLoginPassword)
        const context = { ...req.__securityContext, project_id: config.demoProjectId }
        const incident = await engine.recordLoginAttempt(context, success)
        if (!success) return res.status(401).json({ error: 'Invalid demo credentials', incident_id: incident?.incident_id })
        res.status(200).json({ status: 'authenticated' })
    })
    app.post('/__security/demo-webhook', requireDemoAccess, express.raw({ type: 'application/json', limit: '16kb' }), async (req, res) => {
        const timestamp = String(req.headers['x-security-timestamp'] || '')
        const nonce = String(req.headers['x-security-nonce'] || '')
        const suppliedSignature = String(req.headers['x-security-signature'] || '')
        if (!config.webhookSecret || !/^\d{10,13}$/.test(timestamp) || !/^[a-zA-Z0-9_-]{16,128}$/.test(nonce) || !Buffer.isBuffer(req.body)) {
            return res.status(400).json({ error: 'Malformed signed webhook request' })
        }
        const timestampMs = timestamp.length === 10 ? Number(timestamp) * 1000 : Number(timestamp)
        if (Math.abs(Date.now() - timestampMs) > config.replayTimestampToleranceSeconds * 1000) return res.status(401).json({ error: 'Stale signed request' })
        const expectedSignature = `sha256=${crypto.createHmac('sha256', config.webhookSecret).update(`${timestamp}.${nonce}.`).update(req.body).digest('hex')}`
        if (!safeEqual(suppliedSignature, expectedSignature)) return res.status(401).json({ error: 'Invalid request signature' })
        const context = { ...req.__securityContext, project_id: config.demoProjectId }
        const replay = await engine.reserveWebhookNonce(context, nonce)
        if (!replay.accepted) return res.status(replay.unavailable ? 503 : 409).json({ error: replay.unavailable ? 'Replay protection unavailable' : 'Replay request rejected', incident_id: replay.incident?.incident_id })
        res.status(202).json({ status: 'accepted' })
    })
    app.get('/__security/incidents', requireDemoAccess, async (req, res) => {
        const since = Number(req.query.since || 0)
        const type = typeof req.query.type === 'string' ? req.query.type : undefined
        try {
            res.json({ incidents: await engine.listIncidents(type, Number.isFinite(since) ? since : 0) })
        } catch (error) {
            logger.error('Unable to read security incidents', { message: error.message })
            res.status(503).json({ error: 'Security incident store unavailable' })
        }
    })

    app.use((req, res) => {
        const projectId = projectFromHostname(req.__securityContext.hostname, config)
        if (!projectId) return res.status(400).json({ error: 'Unrecognized deployment host' })
        // S3 stores objects, not directory index documents. Change the incoming
        // request before http-proxy constructs its upstream request.
        if (req.path === '/') {
            const queryIndex = req.url.indexOf('?')
            const query = queryIndex >= 0 ? req.url.slice(queryIndex) : ''
            req.url = `/index.html${query}`
        }
        return proxy.web(req, res, { target: `${basePath}/${encodeURIComponent(projectId)}`, changeOrigin: true })
    })
    return { app, engine, config, proxy }
}

if (require.main === module) {
    const port = Number(process.env.PROXY_PORT || 8000)
    const { app } = createApp()
    app.listen(port, () => console.log(`Reverse Proxy Running on port ${port}`))
}

module.exports = { createApp, createSecurityEngine }

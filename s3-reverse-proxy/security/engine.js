const crypto = require('crypto')

const REQUEST_STREAM = 'security:requests'
const INCIDENT_STREAM = 'security:incidents'

function nowMs() {
    return Date.now()
}

function prune(entries, cutoff) {
    return entries.filter(entry => entry.timestamp >= cutoff)
}

class MemorySecurityState {
    constructor(clock = nowMs) {
        this.clock = clock
        this.rates = new Map()
        this.scans = new Map()
        this.failedLogins = new Map()
        this.nonces = new Map()
        this.cooldowns = new Map()
        this.requests = []
        this.incidents = []
    }

    async consumeRateLimit(key, windowMs) {
        const now = this.clock()
        let value = this.rates.get(key)
        if (!value || value.expiresAt <= now) value = { count: 0, expiresAt: now + windowMs }
        value.count += 1
        this.rates.set(key, value)
        return { count: value.count, retryAfterMs: Math.max(0, value.expiresAt - now) }
    }

    async recordScan(sourceIp, event, windowMs) {
        const now = this.clock()
        const entries = prune(this.scans.get(sourceIp) || [], now - windowMs)
        entries.push({
            timestamp: now,
            path: event.request_path,
            hostname: event.hostname,
            status: event.response_status
        })
        this.scans.set(sourceIp, entries)
        return scanMetrics(entries)
    }

    async recordFailedLogin(sourceIp, windowMs) {
        const now = this.clock()
        const entries = prune(this.failedLogins.get(sourceIp) || [], now - windowMs)
        entries.push({ timestamp: now })
        this.failedLogins.set(sourceIp, entries)
        return entries.length
    }

    async reserveNonce(nonce, ttlMs) {
        const now = this.clock()
        const existing = this.nonces.get(nonce)
        if (existing && existing > now) return false
        this.nonces.set(nonce, now + ttlMs)
        return true
    }

    async deduplicate(key, ttlMs) {
        const now = this.clock()
        const existing = this.cooldowns.get(key)
        if (existing && existing > now) return false
        this.cooldowns.set(key, now + ttlMs)
        return true
    }

    async appendRequest(event) {
        this.requests.push(event)
        if (this.requests.length > 1000) this.requests.shift()
    }

    async appendIncident(incident) {
        this.incidents.push(incident)
        if (this.incidents.length > 1000) this.incidents.shift()
    }

    async listIncidents(type, since) {
        return this.incidents
            .filter(incident => (!type || incident.type === type) && Date.parse(incident.first_seen) >= since)
            .slice()
    }

    async publish() {}
}

function scanMetrics(entries) {
    const paths = new Set(entries.map(entry => entry.path))
    const hostnames = new Set(entries.map(entry => entry.hostname))
    const notFound = entries.filter(entry => entry.status === 404).length
    return {
        requestCount: entries.length,
        uniquePaths: paths.size,
        uniqueHostnames: hostnames.size,
        notFoundRatio: entries.length ? notFound / entries.length : 0
    }
}

class RedisSecurityState {
    constructor(redis, options = {}) {
        this.redis = redis
        this.prefix = options.prefix || 'security:v1'
        this.requestStreamMaxLen = options.requestStreamMaxLen || 10000
        this.incidentStreamMaxLen = options.incidentStreamMaxLen || 10000
    }

    key(name) {
        return `${this.prefix}:${name}`
    }

    async consumeRateLimit(key, windowMs) {
        const result = await this.redis.eval(
            "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); end; return {count, redis.call('PTTL', KEYS[1])}",
            1,
            this.key(`rate:${key}`),
            String(windowMs)
        )
        return { count: Number(result[0]), retryAfterMs: Math.max(0, Number(result[1])) }
    }

    async recordScan(sourceIp, event, windowMs) {
        const now = nowMs()
        const cutoff = now - windowMs
        const ttl = String(windowMs + 60000)
        const eventKey = this.key(`scan:${sourceIp}:events`)
        const pathKey = this.key(`scan:${sourceIp}:paths`)
        const hostKey = this.key(`scan:${sourceIp}:hosts`)
        const notFoundKey = this.key(`scan:${sourceIp}:not-found`)
        const result = await this.redis.eval(
            "for i=1,#KEYS do redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', ARGV[1]) end " +
            "redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3]); redis.call('ZADD', KEYS[2], ARGV[2], ARGV[4]); redis.call('ZADD', KEYS[3], ARGV[2], ARGV[5]); " +
            "if ARGV[6] == '1' then redis.call('ZADD', KEYS[4], ARGV[2], ARGV[3]) end; " +
            "for i=1,#KEYS do redis.call('PEXPIRE', KEYS[i], ARGV[7]) end; " +
            "return {redis.call('ZCARD', KEYS[1]), redis.call('ZCARD', KEYS[2]), redis.call('ZCARD', KEYS[3]), redis.call('ZCARD', KEYS[4])}",
            4,
            eventKey,
            pathKey,
            hostKey,
            notFoundKey,
            String(cutoff),
            String(now),
            event.event_id,
            event.request_path,
            event.hostname,
            event.response_status === 404 ? '1' : '0',
            ttl
        )
        const requestCount = Number(result[0])
        return {
            requestCount,
            uniquePaths: Number(result[1]),
            uniqueHostnames: Number(result[2]),
            notFoundRatio: requestCount ? Number(result[3]) / requestCount : 0
        }
    }

    async recordFailedLogin(sourceIp, windowMs) {
        const now = nowMs()
        const key = this.key(`brute:${sourceIp}`)
        const result = await this.redis.eval(
            "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]); redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3]); redis.call('PEXPIRE', KEYS[1], ARGV[4]); return redis.call('ZCARD', KEYS[1])",
            1,
            key,
            String(now - windowMs),
            String(now),
            crypto.randomUUID(),
            String(windowMs + 60000)
        )
        return Number(result)
    }

    async reserveNonce(nonce, ttlMs) {
        const result = await this.redis.set(this.key(`nonce:${nonce}`), '1', 'PX', ttlMs, 'NX')
        return result === 'OK'
    }

    async deduplicate(key, ttlMs) {
        const result = await this.redis.set(this.key(`cooldown:${key}`), '1', 'PX', ttlMs, 'NX')
        return result === 'OK'
    }

    async appendRequest(event) {
        await this.redis.xadd(REQUEST_STREAM, 'MAXLEN', '~', this.requestStreamMaxLen, '*', 'event', JSON.stringify(event))
    }

    async appendIncident(incident) {
        await this.redis.xadd(INCIDENT_STREAM, 'MAXLEN', '~', this.incidentStreamMaxLen, '*', 'incident', JSON.stringify(incident))
    }

    async listIncidents(type, since) {
        const entries = await this.redis.xrevrange(INCIDENT_STREAM, '+', '-', 'COUNT', 200)
        return entries
            .map(([, fields]) => {
                const index = fields.indexOf('incident')
                return index >= 0 ? JSON.parse(fields[index + 1]) : null
            })
            .filter(Boolean)
            .filter(incident => (!type || incident.type === type) && Date.parse(incident.first_seen) >= since)
    }

    async publish(channel, payload) {
        await this.redis.publish(channel, JSON.stringify(payload))
    }
}

class SecurityEngine {
    constructor({ state, config, logger = console, clock = () => new Date().toISOString() }) {
        this.state = state
        this.config = config
        this.logger = logger
        this.clock = clock
    }

    async consumeRateLimit(context) {
        try {
            const result = await this.state.consumeRateLimit(context.source_ip, this.config.rateWindowMs)
            if (result.count > this.config.rateMaxRequests) {
                await this.createIncident('HTTP_FLOOD', 'high', context, {
                    request_count: result.count,
                    window_seconds: this.config.rateWindowSeconds
                })
            }
            return {
                allowed: result.count <= this.config.rateMaxRequests,
                count: result.count,
                retryAfterSeconds: Math.max(1, Math.ceil(result.retryAfterMs / 1000))
            }
        } catch (error) {
            this.logger.error('Security rate-limit state unavailable; allowing request', { message: error.message })
            return { allowed: true, count: 0, retryAfterSeconds: 0, unavailable: true }
        }
    }

    async observeRequest(event) {
        try {
            await this.state.appendRequest(event)
            const metrics = await this.state.recordScan(event.source_ip, event, this.config.pathWindowMs)
            const isPathScan = metrics.requestCount >= this.config.pathMinRequests &&
                metrics.uniquePaths >= this.config.pathUniqueThreshold &&
                metrics.notFoundRatio >= this.config.pathNotFoundRatio
            if (isPathScan) {
                await this.createIncident('PATH_SCANNING', 'medium', event, {
                    window_seconds: this.config.pathWindowSeconds,
                    request_count: metrics.requestCount,
                    unique_paths: metrics.uniquePaths,
                    unique_hostnames: metrics.uniqueHostnames,
                    not_found_ratio: Number(metrics.notFoundRatio.toFixed(3))
                })
            }
            await this.publishApplicationLog(event)
        } catch (error) {
            this.logger.error('Security request event was not recorded', { message: error.message, event_id: event.event_id })
        }
    }

    async recordLoginAttempt(context, success) {
        if (success) return null
        try {
            const failures = await this.state.recordFailedLogin(context.source_ip, this.config.bruteForceWindowMs)
            if (failures >= this.config.bruteForceFailureThreshold) {
                return await this.createIncident('BRUTE_FORCE', 'high', context, {
                    failed_attempts: failures,
                    window_seconds: this.config.bruteForceWindowSeconds
                })
            }
        } catch (error) {
            this.logger.error('Security login event was not recorded', { message: error.message })
        }
        return null
    }

    async reserveWebhookNonce(context, nonce) {
        try {
            const accepted = await this.state.reserveNonce(nonce, this.config.replayNonceTtlMs)
            if (!accepted) {
                const incident = await this.createIncident('REPLAY_ATTACK', 'high', context, {
                    nonce_fingerprint: fingerprint(nonce),
                    nonce_ttl_seconds: this.config.replayNonceTtlSeconds
                })
                return { accepted: false, incident }
            }
            return { accepted: true, incident: null }
        } catch (error) {
            this.logger.error('Security replay state unavailable; rejecting signed request', { message: error.message })
            return { accepted: false, unavailable: true, incident: null }
        }
    }

    async createIncident(type, severity, context, evidence) {
        const ruleId = RULE_IDS[type]
        const deduplicationKey = `${type}:${context.source_ip}:${context.project_id || 'unknown'}`
        const created = await this.state.deduplicate(deduplicationKey, this.config.alertCooldownMs)
        if (!created) return null
        const timestamp = this.clock()
        const incident = {
            incident_id: crypto.randomUUID(),
            type,
            severity,
            source_ip: context.source_ip,
            project_id: context.project_id || null,
            deployment_id: context.deployment_id || context.project_id || null,
            first_seen: timestamp,
            last_seen: timestamp,
            status: 'open',
            rule_id: ruleId,
            evidence,
            event_count: evidence.request_count || evidence.failed_attempts || 1
        }
        await this.state.appendIncident(incident)
        try {
            await this.state.publish('security:incidents', incident)
        } catch (error) {
            this.logger.error('Security incident stored but could not be published', { message: error.message, incident_id: incident.incident_id })
        }
        return incident
    }

    async publishApplicationLog(event) {
        if (!event.project_id) return
        const accessLog = {
            timestamp: event.timestamp,
            request_id: event.request_id,
            method: event.method,
            path: event.safe_request_path,
            response_status: event.response_status,
            response_bytes: event.response_bytes,
            duration_ms: event.duration_ms,
            proxy_error: event.proxy_error
        }
        try {
            await this.state.publish(`application-logs:${event.project_id}`, accessLog)
        } catch (error) {
            this.logger.error('Application access log could not be published', { message: error.message, request_id: event.request_id })
        }
    }

    async listIncidents(type, since) {
        return this.state.listIncidents(type, since)
    }
}

const RULE_IDS = {
    PATH_SCANNING: 'path-scan-v1',
    BRUTE_FORCE: 'brute-force-v1',
    HTTP_FLOOD: 'http-flood-v1',
    REPLAY_ATTACK: 'replay-attack-v1'
}

function fingerprint(value) {
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)
}

module.exports = { MemorySecurityState, RedisSecurityState, SecurityEngine, fingerprint }

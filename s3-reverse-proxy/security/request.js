const crypto = require('crypto')

const SENSITIVE_QUERY_KEY = /(?:token|secret|password|passwd|authorization|cookie|key|signature|sig)/i

function normalizeIp(value) {
    if (!value) return 'unknown'
    let ip = String(value).trim().toLowerCase()
    if (ip.startsWith('::ffff:')) ip = ip.slice(7)
    const zoneIndex = ip.indexOf('%')
    if (zoneIndex >= 0) ip = ip.slice(0, zoneIndex)
    return ip || 'unknown'
}

function isTrustedProxy(remoteIp, trustedProxyIps) {
    return trustedProxyIps.includes(remoteIp) ||
        (trustedProxyIps.includes('loopback') && (remoteIp === '127.0.0.1' || remoteIp === '::1'))
}

function sourceIpFromRequest(req, trustedProxyIps) {
    const remoteIp = normalizeIp(req.socket?.remoteAddress)
    if (!isTrustedProxy(remoteIp, trustedProxyIps)) return remoteIp
    const forwarded = req.headers['x-forwarded-for']
    if (!forwarded) return remoteIp
    return normalizeIp(String(forwarded).split(',')[0])
}

function sanitizeRequestPath(url) {
    const parsed = new URL(url || '/', 'http://proxy.local')
    for (const key of [...parsed.searchParams.keys()]) {
        if (SENSITIVE_QUERY_KEY.test(key)) parsed.searchParams.set(key, '[REDACTED]')
    }
    const query = parsed.searchParams.toString()
    return query ? `${parsed.pathname}?${query}` : parsed.pathname
}

function normalizedPath(url) {
    return new URL(url || '/', 'http://proxy.local').pathname
}

function hostnameFromRequest(req) {
    const host = String(req.headers.host || '').trim().toLowerCase().replace(/\.$/, '')
    if (!host) return ''
    if (host.startsWith('[')) return host.slice(1, host.indexOf(']'))
    return host.split(':')[0]
}

function projectFromHostname(hostname, config) {
    const suffix = config.allowedHostSuffix
    if (hostname === suffix) return config.defaultProjectId
    const marker = `.${suffix}`
    if (!hostname.endsWith(marker)) return null
    const projectId = hostname.slice(0, -marker.length)
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(projectId)) return null
    return projectId
}

function requestContext(req, config) {
    const hostname = hostnameFromRequest(req)
    const projectId = projectFromHostname(hostname, config)
    return {
        event_id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        source_ip: sourceIpFromRequest(req, config.trustedProxyIps),
        hostname,
        project_id: projectId,
        request_path: normalizedPath(req.originalUrl || req.url),
        safe_request_path: sanitizeRequestPath(req.originalUrl || req.url),
        method: String(req.method || 'GET').toUpperCase(),
        request_id: req.headers['x-request-id'] && /^[a-zA-Z0-9._-]{1,128}$/.test(req.headers['x-request-id'])
            ? req.headers['x-request-id']
            : crypto.randomUUID(),
        user_agent: String(req.headers['user-agent'] || '').slice(0, 512)
    }
}

function safeEqual(left, right) {
    const leftBuffer = Buffer.from(left || '')
    const rightBuffer = Buffer.from(right || '')
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

module.exports = { normalizeIp, sourceIpFromRequest, sanitizeRequestPath, hostnameFromRequest, projectFromHostname, requestContext, safeEqual }

function numberEnv(env, name, fallback, minimum = 1) {
    const value = env[name]
    if (value === undefined || value === '') return fallback
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < minimum) {
        throw new Error(`${name} must be a number greater than or equal to ${minimum}`)
    }
    return parsed
}

function ratioEnv(env, name, fallback) {
    const value = env[name]
    if (value === undefined || value === '') return fallback
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error(`${name} must be a number from 0 to 1`)
    }
    return parsed
}

function booleanEnv(env, name, fallback = false) {
    if (env[name] === undefined) return fallback
    return String(env[name]).toLowerCase() === 'true'
}

function loadSecurityConfig(env = process.env) {
    const pathWindowSeconds = numberEnv(env, 'SECURITY_PATH_WINDOW_SECONDS', 10)
    const bruteForceWindowSeconds = numberEnv(env, 'SECURITY_BRUTE_FORCE_WINDOW_SECONDS', 60)
    const rateWindowSeconds = numberEnv(env, 'SECURITY_RATE_WINDOW_SECONDS', 10)
    const replayNonceTtlSeconds = numberEnv(env, 'SECURITY_REPLAY_NONCE_TTL_SECONDS', 300)
    return {
        pathWindowSeconds,
        pathWindowMs: pathWindowSeconds * 1000,
        pathUniqueThreshold: numberEnv(env, 'SECURITY_PATH_UNIQUE_THRESHOLD', 30),
        pathMinRequests: numberEnv(env, 'SECURITY_PATH_MIN_REQUESTS', 30),
        pathNotFoundRatio: ratioEnv(env, 'SECURITY_PATH_404_RATIO_THRESHOLD', 0.6),
        bruteForceWindowSeconds,
        bruteForceWindowMs: bruteForceWindowSeconds * 1000,
        bruteForceFailureThreshold: numberEnv(env, 'SECURITY_BRUTE_FORCE_FAILURE_THRESHOLD', 10),
        rateWindowSeconds,
        rateWindowMs: rateWindowSeconds * 1000,
        rateMaxRequests: numberEnv(env, 'SECURITY_RATE_MAX_REQUESTS', 100),
        alertCooldownMs: numberEnv(env, 'SECURITY_ALERT_COOLDOWN_SECONDS', 60) * 1000,
        replayTimestampToleranceSeconds: numberEnv(env, 'SECURITY_REPLAY_TIMESTAMP_TOLERANCE_SECONDS', 300),
        replayNonceTtlSeconds,
        replayNonceTtlMs: replayNonceTtlSeconds * 1000,
        streamMaxLen: numberEnv(env, 'SECURITY_REDIS_STREAM_MAXLEN', 10000),
        trustedProxyIps: String(env.SECURITY_TRUSTED_PROXY_IPS || '')
            .split(',').map(value => value.trim()).filter(Boolean),
        allowedHostSuffix: String(env.PROXY_ALLOWED_HOST_SUFFIX || 'localhost').toLowerCase(),
        defaultProjectId: env.DEFAULT_PROJECT_ID || 'default-project',
        demoProjectId: env.SECURITY_DEMO_PROJECT_ID || 'security-demo',
        demoEndpointsEnabled: booleanEnv(env, 'SECURITY_DEMO_ENDPOINTS_ENABLED'),
        simulationMode: booleanEnv(env, 'SIMULATION_MODE'),
        simulationToken: env.SECURITY_SIMULATION_TOKEN || '',
        demoLoginUsername: env.SECURITY_DEMO_LOGIN_USERNAME || 'demo-user',
        demoLoginPassword: env.SECURITY_DEMO_LOGIN_PASSWORD || '',
        webhookSecret: env.SECURITY_WEBHOOK_HMAC_SECRET || ''
    }
}

module.exports = { loadSecurityConfig }

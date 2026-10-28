# Security detection and simulation

The reverse proxy records a normalized request event after each response finishes. Events contain request metadata only: event ID, timestamp, normalized source IP, host, project, sanitized path, method, response status, response bytes, duration, user agent, and request ID. Request bodies, cookies, authorization headers, passwords, HMAC values, and unredacted sensitive query values are never recorded.

`REDIS_URL` is used for bounded Redis Streams, atomic request counters, sliding-window state, nonce reservation, and alert cooldowns. Request events are appended to `security:requests`; incidents are appended to `security:incidents`. Both streams use `MAXLEN ~ SECURITY_REDIS_STREAM_MAXLEN`. The detector runs at the proxy, and Redis `SET ... NX` prevents multiple proxy instances from creating duplicate incidents for the same source, project, and cooldown period.

Detection runs inline from the finished request event; Redis Streams provide an audit and integration feed. A durable incident consumer should create a group on `security:incidents`, read with `XREADGROUP`, write its database record, then call `XACK` only after that write succeeds. Do not use the API server's Redis Pub/Sub subscription as durable delivery: it provides live Socket.IO notifications only.

There is no database or dashboard in this repository. Incidents are retained in the bounded Redis incident stream. The API server subscribes to the `security:incidents` channel and emits `security:incident` to the matching Socket.IO room: `project:<project-id>`.

## Required configuration

Copy [`.env.example`](.env.example) to `.env`. Set `REDIS_URL`, the deployment variables already used by the platform, and these values:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROXY_ALLOWED_HOST_SUFFIX` | `localhost` | Valid deployment host suffix. A project is served as `<project>.<suffix>`. |
| `SECURITY_TRUSTED_PROXY_IPS` | empty | Comma-separated exact proxy IPs. `loopback` permits forwarded client IPs only from `127.0.0.1` and `::1`. |
| `SECURITY_PATH_WINDOW_SECONDS` | `10` | Path-scan sliding window. |
| `SECURITY_PATH_UNIQUE_THRESHOLD` | `30` | Unique paths required to trigger path scanning. |
| `SECURITY_PATH_MIN_REQUESTS` | `30` | Minimum requests in the path-scan window. |
| `SECURITY_PATH_404_RATIO_THRESHOLD` | `0.60` | Required fraction of 404 responses. |
| `SECURITY_BRUTE_FORCE_WINDOW_SECONDS` | `60` | Failed-login evaluation window. |
| `SECURITY_BRUTE_FORCE_FAILURE_THRESHOLD` | `10` | Failed demo-login attempts required to alert. |
| `SECURITY_RATE_WINDOW_SECONDS` | `10` | Fixed rate-limit window. |
| `SECURITY_RATE_MAX_REQUESTS` | `100` | Requests per source IP allowed in the rate window. The next request is a 429. |
| `SECURITY_ALERT_COOLDOWN_SECONDS` | `60` | Incident deduplication period. |
| `SECURITY_REPLAY_TIMESTAMP_TOLERANCE_SECONDS` | `300` | Maximum signed webhook timestamp skew. |
| `SECURITY_REPLAY_NONCE_TTL_SECONDS` | `300` | Redis TTL for accepted webhook nonces. |
| `SOCKET_AUTH_TOKEN` | unset | If set, Socket.IO clients must provide it in `auth.token`. |

## Run locally

Start Redis/Valkey first, then start the API and proxy in separate terminals:

```powershell
cd api-server
npm start

cd ..\s3-reverse-proxy
npm start
```

Open `http://localhost:9000` to use the included single-page deployment console. It accepts a Git URL and optional project slug, shows build output from `logs:<project>`, shows sanitized deployed-site access logs, and displays a security alert when a subscribed project emits `security:incident`. If `SOCKET_AUTH_TOKEN` is configured, enter it in the page before deploying; it stays in memory only.

## Rule behavior

- `PATH_SCANNING` requires the configured request count, unique path count, and 404 ratio from a single normalized source IP within the window.
- `BRUTE_FORCE` only counts failed results emitted by the isolated demo login endpoint. An arbitrary 401 does not count as a failed login.
- `HTTP_FLOOD` uses an atomic Redis counter with a key TTL. Excess requests receive `429 Too Many Requests` with `Retry-After`.
- `REPLAY_ATTACK` applies only to the signed demo webhook. Its canonical HMAC input is `<timestamp>.<nonce>.<raw UTF-8 request body>`. It verifies `sha256=<hex HMAC-SHA256>` in constant time and atomically reserves the nonce using Redis `SET NX PX`.

## Controlled simulations

Enable only in a local or dedicated staging `.env`:

```text
SIMULATION_MODE=true
SECURITY_DEMO_ENDPOINTS_ENABLED=true
SECURITY_SIMULATION_TOKEN=<long random test token>
SECURITY_DEMO_LOGIN_PASSWORD=<dummy test password>
SECURITY_WEBHOOK_HMAC_SECRET=<long random test secret>
```

The simulator refuses non-local targets unless the exact origin is set in `AUTHORIZED_SIMULATION_TARGETS`. It has fixed request and timeout bounds. From the project root, run:

```powershell
$env:SIMULATION_MODE='true'
$env:TARGET_URL='http://localhost:8000'
$env:SECURITY_SIMULATION_TOKEN='<simulation token>'
$env:SECURITY_WEBHOOK_HMAC_SECRET='<webhook secret>'

node security-simulator/index.js path-scan
node security-simulator/index.js brute-force
node security-simulator/index.js http-flood
node security-simulator/index.js replay
```

Each simulation uses only `/__security/*` demo endpoints, checks the expected response, polls the simulation-only incident endpoint, and exits nonzero when the expected incident does not appear.

## Tests

```powershell
cd s3-reverse-proxy
npm test
```

The tests use the in-memory security state only. They do not contact AWS, S3, Redis, or public targets.

## Operational limitations

- Configure an IAM-backed production Redis endpoint before enabling security detection. If Redis is unavailable, the proxy logs the failure and allows traffic instead of becoming an outage; signed webhooks are rejected with 503 because replay safety cannot be guaranteed.
- Socket room membership is syntactically scoped by project and can require `SOCKET_AUTH_TOKEN`. This repository has no tenant identity system, so connect the existing application authentication layer before exposing incident feeds to separate tenants.
- A durable database and dashboard do not exist in this codebase. Redis Stream retention is intentionally bounded, so connect a consumer group to persist incidents if long-term storage is required.

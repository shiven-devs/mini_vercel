const express = require('express')
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })
const { generateSlug } = require('random-word-slugs')
const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs')
const { Server } = require('socket.io')
const Redis = require('ioredis')
const { createClient } = require('@supabase/supabase-js')

const app = express()
const PORT = Number(process.env.API_PORT || 9000)
const SOCKET_PORT = Number(process.env.SOCKET_PORT || 9002)

app.use(express.json())

// ==========================================
// 1. REDIS SUBSCRIBER
// ==========================================

const subscriber = new Redis(requiredEnv('REDIS_URL'))

function requiredEnv(name) {
    const value = process.env[name]
    if (!value) throw new Error(`${name} environment variable is required`)
    return value
}

// ==========================================
// 1b. SUPABASE (optional log persistence)
// ==========================================

// Service role key bypasses RLS, so keep it on the server only.
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false }
    })
    : null

if (!supabase) {
    console.warn('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set: build logs will not be saved')
}

// Final lines published by build_server/script.js
function statusFromLog(log) {
    if (log.includes('Deployment Complete!')) return 'ready'
    if (log.startsWith('Deployment failed')) return 'failed'
    return null
}

async function saveLog(channel, message) {
    if (!supabase) return

    const slug = channel.slice('logs:'.length)

    let log = message
    try {
        log = JSON.parse(message).log ?? message
    } catch {}

    const { error } = await supabase
        .from('deployment_logs')
        .insert({ slug, log: String(log) })

    if (error) {
        console.error('Failed to save build log:', error.message)
        return
    }

    const status = statusFromLog(String(log))
    if (status) {
        await supabase.from('deployments').update({ status }).eq('slug', slug)
    }
}

// ==========================================
// 2. SOCKET.IO SERVER
// ==========================================

const io = new Server({
    cors: {
        origin: '*'
    }
})

io.on('connection', socket => {
    console.log('Client connected:', socket.id)

    // Client subscribes to a project's logs
    socket.on('subscribe', async channel => {
    await socket.join(channel)

    console.log(`${socket.id} joined room: ${channel}`)

    socket.emit('message', `Joined ${channel}`)

    // Test: directly send a message to the room
    io.to(channel).emit('message', 'TEST: Socket.IO room is working')
})

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id)
    })
})

io.listen(SOCKET_PORT, () => {
    console.log(`Socket Server running on port ${SOCKET_PORT}`)
})

// ==========================================
// 3. REDIS -> SOCKET.IO LOG FORWARDING
// ==========================================

async function initRedisSubscribe() {
    console.log('Subscribing to build logs...')

    // Listen to all Redis channels starting with logs:
    await subscriber.psubscribe('logs:*')

    subscriber.on('pmessage', (pattern, channel, message) => {
        console.log('Redis channel:', channel)
        console.log('Build log:', message)

        // Forward the log to clients in the matching Socket.IO room
        io.to(channel).emit('message', message)

        // Persist the log so the dashboard can show it after the build ends
        saveLog(channel, message).catch(error => {
            console.error('Failed to save build log:', error.message)
        })
    })

    console.log('Subscribed to Redis pattern: logs:*')
}

initRedisSubscribe().catch(error => {
    console.error('Redis subscription error:', error)
})

// ==========================================
// 4. AWS ECS CLIENT
// ==========================================

const ecsClient = new ECSClient({
    region: process.env.AWS_REGION || 'ap-southeast-2'
})

const config = {
    CLUSTER: requiredEnv('ECS_CLUSTER_ARN'),
    TASK: requiredEnv('ECS_TASK_DEFINITION_ARN'),
    SUBNETS: requiredEnv('ECS_SUBNETS').split(',').map(value => value.trim()).filter(Boolean),
    SECURITY_GROUPS: requiredEnv('ECS_SECURITY_GROUPS').split(',').map(value => value.trim()).filter(Boolean)
}

// ==========================================
// 5. CREATE PROJECT DEPLOYMENT
// ==========================================

app.post('/project', async (req, res) => {
    try {
        const { gitURL, slug } = req.body

        if (!gitURL) {
            return res.status(400).json({
                error: 'gitURL is required'
            })
        }

        const projectSlug = slug || generateSlug()

        const command = new RunTaskCommand({
            cluster: config.CLUSTER,
            taskDefinition: config.TASK,
            launchType: 'FARGATE',
            count: 1,

            networkConfiguration: {
                awsvpcConfiguration: {
                    assignPublicIp: 'ENABLED',

                    subnets: config.SUBNETS,
                    securityGroups: config.SECURITY_GROUPS
                }
            },

            overrides: {
                containerOverrides: [
                    {
                        name: 'Main',

                        environment: [
                            {
                                name: 'REDIS_URL',
                                value: requiredEnv('REDIS_URL')
                            },
                            {
                                name: 'AWS_REGION',
                                value: process.env.AWS_REGION || 'ap-southeast-2'
                            },
                            {
                                name: 'AWS_S3_BUCKET',
                                value: requiredEnv('AWS_S3_BUCKET')
                            },
                            {
                                name: 'GIT_REPOSITORY__URL',
                                value: gitURL
                            },
                            {
                                name: 'PROJECT_ID',
                                value: projectSlug
                            }
                        ]
                    }
                ]
            }
        })

        const result = await ecsClient.send(command)

        // Check whether ECS failed to start the task
        if (result.failures?.length) {
            return res.status(500).json({
                error: 'Failed to start ECS task',
                failures: result.failures
            })
        }

        return res.json({
            status: 'queued',

            data: {
                projectSlug,
                url: `http://${projectSlug}.localhost:8000`
            }
        })

    } catch (error) {
        console.error('Project deployment error:', error)

        return res.status(500).json({
            error: error.message,
            name: error.name
        })
    }
})

// ==========================================
// 6. START EXPRESS API SERVER
// ==========================================

app.listen(PORT, () => {
    console.log(`API Server running on port ${PORT}`)
})

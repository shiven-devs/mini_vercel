const express = require('express')
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })
const { generateSlug } = require('random-word-slugs')
const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs')
const { Server } = require('socket.io')
const Redis = require('ioredis')

const app = express()
const PORT = Number(process.env.API_PORT || 9000)
const SOCKET_PORT = Number(process.env.SOCKET_PORT || 9002)

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))
app.get('/runtime-config.js', (req, res) => {
    res.type('application/javascript').send(`window.DEPLOYMENT_DASHBOARD_CONFIG = ${JSON.stringify({
        socketPort: SOCKET_PORT,
        securityDemoProject: process.env.SECURITY_DEMO_PROJECT_ID || 'security-demo',
        defaultProject: process.env.DEFAULT_PROJECT_ID || 'default-project'
    })};`)
})

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
// 2. SOCKET.IO SERVER
// ==========================================

const io = new Server({
    cors: {
        origin: '*'
    }
})

io.on('connection', socket => {
    const socketToken = process.env.SOCKET_AUTH_TOKEN
    if (socketToken && socket.handshake.auth?.token !== socketToken) {
        socket.emit('error', 'Unauthorized socket')
        socket.disconnect(true)
        return
    }
    console.log('Client connected:', socket.id)

    socket.on('subscribe', async channel => {
    if (typeof channel !== 'string' || !/^(logs|project):[a-z0-9][a-z0-9-]{0,62}$/.test(channel)) {
        return socket.emit('error', 'Invalid subscription channel')
    }
    await socket.join(channel)

    console.log(`${socket.id} joined room: ${channel}`)

    socket.emit('message', `Joined ${channel}`)

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

    await subscriber.psubscribe('logs:*', 'security:incidents', 'application-logs:*')

    subscriber.on('pmessage', (pattern, channel, message) => {
        if (channel === 'security:incidents') {
            try {
                const incident = JSON.parse(message)
                if (incident.project_id && /^[a-z0-9][a-z0-9-]{0,62}$/.test(incident.project_id)) {
                    io.to(`project:${incident.project_id}`).emit('security:incident', incident)
                }
            } catch (error) {
                console.error('Security incident parse error:', error.message)
            }
            return
        }
        if (channel.startsWith('application-logs:')) {
            const projectId = channel.slice('application-logs:'.length)
            try {
                const log = JSON.parse(message)
                if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(projectId)) {
                    io.to(`project:${projectId}`).emit('application:log', log)
                }
            } catch (error) {
                console.error('Application log parse error:', error.message)
            }
            return
        }
        console.log('Redis channel:', channel)
        console.log('Build log:', message)

        // Forward the log to clients in the matching Socket.IO room
        io.to(channel).emit('message', message)
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

        io.to(`project:${projectSlug}`).emit('application:log', {
            timestamp: new Date().toISOString(),
            level: 'info',
            message: 'Deployment task queued'
        })

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

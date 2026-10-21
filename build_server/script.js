const { exec } = require('child_process')
const path = require('path')
const fs = require('fs')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const mime = require('mime-types')
const Redis = require('ioredis')

// ==========================================
// 1. REDIS PUBLISHER
// ==========================================

const publisher = new Redis(requiredEnv('REDIS_URL'))

publisher.on('error', error => {
    console.error('Redis error:', error.message)
})

// ==========================================
// 2. AWS S3 CLIENT
// ==========================================

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-southeast-2'
})

const PROJECT_ID = process.env.PROJECT_ID
const BUCKET_NAME = requiredEnv('AWS_S3_BUCKET')

function requiredEnv(name) {
    const value = process.env[name]
    if (!value) throw new Error(`${name} environment variable is required`)
    return value
}

// ==========================================
// 3. PUBLISH LOGS TO REDIS
// ==========================================

function publishLog(log) {
    console.log(log)

    if (!PROJECT_ID) {
        console.error('PROJECT_ID is missing')
        return
    }

    const channel = `logs:${PROJECT_ID}`

    publisher.publish(
        channel,
        JSON.stringify({ log: String(log) })
    ).catch(error => {
        console.error('Redis publish failed:', error.message)
    })
}

// ==========================================
// 4. RECURSIVELY GET FILES
// ==========================================

function getFilesRecursively(dir, baseDir = dir) {
    let files = []

    for (const entry of fs.readdirSync(dir, {
        withFileTypes: true
    })) {
        const fullPath = path.join(dir, entry.name)

        if (entry.isDirectory()) {
            files = files.concat(
                getFilesRecursively(fullPath, baseDir)
            )
        } else if (entry.isFile()) {
            files.push({
                fullPath,
                relativePath: path.relative(baseDir, fullPath)
            })
        }
    }

    return files
}

// ==========================================
// 5. UPLOAD FILES TO S3
// ==========================================

async function uploadDirectory(folderPath) {
    const files = getFilesRecursively(folderPath)

    publishLog(`Starting upload of ${files.length} files...`)

    for (const file of files) {
        const relativePath = file.relativePath
            .split(path.sep)
            .join('/')

        const s3Key = `__outputs/${PROJECT_ID}/${relativePath}`

        publishLog(`Uploading ${relativePath}`)

        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: s3Key,
            Body: fs.createReadStream(file.fullPath),
            ContentType:
                mime.lookup(file.fullPath) ||
                'application/octet-stream'
        })

        await s3Client.send(command)

        publishLog(`Uploaded ${relativePath}`)
    }

    publishLog('All files uploaded successfully!')
}

// ==========================================
// 6. CHECK BUILD SCRIPT
// ==========================================

function hasBuildScript(packageJsonPath) {
    try {
        const packageJson = JSON.parse(
            fs.readFileSync(packageJsonPath, 'utf8')
        )

        return Boolean(
            packageJson.scripts &&
            typeof packageJson.scripts.build === 'string' &&
            packageJson.scripts.build.trim()
        )
    } catch (error) {
        publishLog(`Could not read package.json: ${error.message}`)
        return false
    }
}

// ==========================================
// 7. BUILD PROJECT AND UPLOAD OUTPUT
// ==========================================

async function init() {
    try {
        if (!PROJECT_ID) {
            throw new Error(
                'PROJECT_ID environment variable is missing'
            )
        }

        const outDirPath = path.join(__dirname, 'output')

        if (!fs.existsSync(outDirPath)) {
            throw new Error('Repository folder not found: output')
        }

        publishLog('Executing script.js')
        publishLog('Build Started...')

        const packageJsonPath = path.join(
            outDirPath,
            'package.json'
        )

        let outputFolderPath

        // CASE 1: Project has a build script
        if (
            fs.existsSync(packageJsonPath) &&
            hasBuildScript(packageJsonPath)
        ) {
            publishLog('Build script detected')
            publishLog('Installing dependencies...')

            const p = exec(
                'npm install && npm run build',
                { cwd: outDirPath }
            )

            p.stdout.on('data', data => {
                publishLog(data.toString())
            })

            p.stderr.on('data', data => {
                publishLog(`error: ${data.toString()}`)
            })

            const exitCode = await new Promise((resolve, reject) => {
                p.on('error', reject)
                p.on('close', resolve)
            })

            if (exitCode !== 0) {
                throw new Error(
                    `Build failed with exit code ${exitCode}`
                )
            }

            publishLog('Build Complete')

            const possibleFolders = ['dist', 'build', 'out']

            for (const folder of possibleFolders) {
                const candidate = path.join(outDirPath, folder)

                if (
                    fs.existsSync(candidate) &&
                    fs.statSync(candidate).isDirectory()
                ) {
                    outputFolderPath = candidate

                    publishLog(
                        `Build output detected: ${folder}`
                    )

                    break
                }
            }

            if (!outputFolderPath) {
                throw new Error(
                    'No build output found: dist, build, or out'
                )
            }

        } else {
            // CASE 2: Plain static website
            publishLog(
                'No build script detected. Checking static website...'
            )

            const indexPath = path.join(
                outDirPath,
                'index.html'
            )

            if (
                !fs.existsSync(indexPath) ||
                !fs.statSync(indexPath).isFile()
            ) {
                throw new Error(
                    'No build script and no root index.html found'
                )
            }

            outputFolderPath = outDirPath

            publishLog(
                'Static website detected. Skipping build.'
            )
        }

        // ==========================================
        // 8. UPLOAD BUILD OUTPUT
        // ==========================================

        await uploadDirectory(outputFolderPath)

        publishLog('Deployment Complete!')
        console.log('Done...')

    } catch (error) {
        console.error('Deployment failed:', error)

        publishLog(`Deployment failed: ${error.message}`)

        process.exitCode = 1

    } finally {
        // Wait for queued Redis commands before disconnecting
        try {
            await publisher.quit()
        } catch (error) {
            console.error(
                'Redis shutdown error:',
                error.message
            )
        }
    }
}

init()

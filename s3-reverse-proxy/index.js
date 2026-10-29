const express = require('express')
const httpProxy = require('http-proxy')
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })

const app = express()
const PORT = Number(process.env.PORT || process.env.PROXY_PORT || 8000)

const BASE_PATH = process.env.S3_OUTPUT_BASE_URL
if (!BASE_PATH) throw new Error('S3_OUTPUT_BASE_URL environment variable is required')

const proxy = httpProxy.createProxy()

app.use((req, res) => {
    const hostname = req.hostname;
    const subdomain = hostname.split('.')[0];

    // Custom Domain - DB Query

    const resolvesTo = `${BASE_PATH}/${subdomain}`

    return proxy.web(req, res, { target: resolvesTo, changeOrigin: true })

})

proxy.on('proxyReq', (proxyReq, req, res) => {
    const url = req.url;
    if (url === '/')
        proxyReq.path += 'index.html'

})

app.listen(PORT, () => console.log(`Reverse Proxy Running..${PORT}`))

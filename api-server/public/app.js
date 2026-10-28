const config = window.DEPLOYMENT_DASHBOARD_CONFIG || { socketPort: 9002 }
const form = document.querySelector('#deploy-form')
const status = document.querySelector('#form-status')
const buildLog = document.querySelector('#build-log')
const applicationLog = document.querySelector('#application-log')
const connectionStatus = document.querySelector('#connection-status')
const deployButton = document.querySelector('#deploy-button')
const connectButton = document.querySelector('#connect-button')
const deploymentLink = document.querySelector('#deployment-link')
const alertBox = document.querySelector('#security-alert')
const alertTitle = document.querySelector('#alert-title')
const alertMessage = document.querySelector('#alert-message')

let socket
let activeProject

function appendLog(element, message) {
  const current = element.textContent === 'Waiting for a deployment…' || element.textContent.startsWith('Access logs appear') ? '' : `${element.textContent}\n`
  element.textContent = `${current}${message}`.slice(-24000)
  element.scrollTop = element.scrollHeight
}

function timestamp() {
  return new Date().toLocaleTimeString()
}

function parseBuildLog(payload) {
  if (typeof payload !== 'string') return JSON.stringify(payload)
  try {
    const parsed = JSON.parse(payload)
    return parsed.log || payload
  } catch {
    return payload
  }
}

function showAlert(incident) {
  alertTitle.textContent = `${incident.type.replaceAll('_', ' ')} detected`
  const evidence = incident.evidence ? Object.entries(incident.evidence).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value}`).join(' · ') : ''
  alertMessage.textContent = `A security rule triggered for ${incident.project_id || 'this project'} from ${incident.source_ip || 'an unknown source'}. ${evidence}`
  alertBox.classList.remove('hidden')
}

function socketUrl() {
  return `${window.location.protocol}//${window.location.hostname}:${config.socketPort}`
}

function connectSocket(token) {
  if (socket?.connected) return Promise.resolve(socket)
  if (typeof window.io !== 'function') return Promise.reject(new Error('Socket.IO client failed to load'))
  socket?.disconnect()
  socket = window.io(socketUrl(), { auth: token ? { token } : {}, transports: ['websocket', 'polling'] })
  socket.on('connect', () => {
    connectionStatus.textContent = 'Live logs connected'
    connectionStatus.className = 'connection connected'
    subscribeToProject()
  })
  socket.on('disconnect', () => {
    connectionStatus.textContent = 'Live logs disconnected'
    connectionStatus.className = 'connection error'
  })
  socket.on('connect_error', error => {
    connectionStatus.textContent = `Log connection error: ${error.message}`
    connectionStatus.className = 'connection error'
  })
  socket.on('message', message => appendLog(buildLog, `[${timestamp()}] ${parseBuildLog(message)}`))
  socket.on('application:log', log => {
    const text = log.message || `${log.method || 'REQUEST'} ${log.path || ''} → ${log.response_status ?? ''} ${log.duration_ms ?? ''}ms`
    appendLog(applicationLog, `[${new Date(log.timestamp || Date.now()).toLocaleTimeString()}] ${text}`)
  })
  socket.on('security:incident', incident => {
    showAlert(incident)
    appendLog(applicationLog, `[${timestamp()}] SECURITY ${incident.type}: ${JSON.stringify(incident.evidence)}`)
  })
  socket.on('error', message => {
    connectionStatus.textContent = `Log connection error: ${message}`
    connectionStatus.className = 'connection error'
  })
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket))
    socket.once('connect_error', reject)
  })
}

function subscribeToProject() {
  if (!socket?.connected) return
  if (activeProject) {
    socket.emit('subscribe', `logs:${activeProject}`)
    socket.emit('subscribe', `project:${activeProject}`)
  }
  if (config.securityDemoProject) socket.emit('subscribe', `project:${config.securityDemoProject}`)
  if (config.defaultProject) socket.emit('subscribe', `project:${config.defaultProject}`)
}

async function loadSocketClient() {
  const script = document.createElement('script')
  script.src = `${socketUrl()}/socket.io/socket.io.js`
  script.async = true
  document.head.append(script)
  await new Promise((resolve, reject) => { script.onload = resolve; script.onerror = () => reject(new Error('Unable to load Socket.IO client')) })
}

form.addEventListener('submit', async event => {
  event.preventDefault()
  const gitURL = document.querySelector('#git-url').value.trim()
  const slug = document.querySelector('#project-slug').value.trim()
  const token = document.querySelector('#socket-token').value
  status.className = 'form-status'
  deploymentLink.classList.add('hidden')
  deployButton.disabled = true
  status.textContent = 'Submitting deployment…'
  try {
    await connectSocket(token)
    const response = await fetch('/project', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gitURL, ...(slug && { slug }) })
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Deployment could not be created')
    activeProject = result.data.projectSlug
    buildLog.textContent = ''
    appendLog(buildLog, `[${timestamp()}] Deployment queued for ${activeProject}`)
    appendLog(applicationLog, `[${timestamp()}] Deployment task queued`)
    subscribeToProject()
    status.textContent = `Deployment queued: ${activeProject}`
    deploymentLink.href = result.data.url
    deploymentLink.textContent = `Open ${result.data.url}`
    deploymentLink.classList.remove('hidden')
  } catch (error) {
    status.className = 'form-status error'
    status.textContent = error.message
  } finally {
    deployButton.disabled = false
  }
})

connectButton.addEventListener('click', async () => {
  connectButton.disabled = true
  try {
    await connectSocket(document.querySelector('#socket-token').value)
    subscribeToProject()
  } catch (error) {
    connectionStatus.textContent = `Log connection error: ${error.message}`
    connectionStatus.className = 'connection error'
  } finally {
    connectButton.disabled = false
  }
})

document.querySelectorAll('[data-clear]').forEach(button => button.addEventListener('click', () => {
  document.querySelector(`#${button.dataset.clear}`).textContent = ''
}))
document.querySelector('#dismiss-alert').addEventListener('click', () => alertBox.classList.add('hidden'))

loadSocketClient().then(() => {
  connectionStatus.textContent = 'Enter a repository to connect to live logs'
}).catch(error => {
  connectionStatus.textContent = error.message
  connectionStatus.className = 'connection error'
})

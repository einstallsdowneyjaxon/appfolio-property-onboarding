import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PORT || 8788)
const appUrl = `http://127.0.0.1:${port}`
const propertyJobLogFile = path.join(rootDir, 'property-onboarding-job.log')
const propertyJobQueue = []
let activePropertyJob = null

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

function appendPropertyJobLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    fs.appendFileSync(propertyJobLogFile, line, 'utf8')
  } catch (error) {
    console.error('Could not write property onboarding job log.', error)
  }
  console.log(line.trimEnd())
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 2_000_000) {
        reject(new Error('Request body is too large.'))
        request.destroy()
      }
    })
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function createPropertyJob(payload) {
  const rowNumber = payload?.rowNumber ?? payload?.row ?? payload?.sheetRow ?? payload?.row_number ?? ''
  return {
    jobId: `property-onboarding-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    payload,
    rowNumber,
    status: 'QUEUED',
    queuedAt: new Date().toISOString(),
    startedAt: '',
    finishedAt: '',
    pid: null,
  }
}

function getPropertyQueueSnapshot(job = null) {
  const queued = propertyJobQueue.map((entry, index) => ({
    jobId: entry.jobId,
    rowNumber: entry.rowNumber,
    status: entry.status,
    queuePosition: index + 1,
    queuedAt: entry.queuedAt,
  }))
  const queuePosition = job
    ? propertyJobQueue.findIndex((entry) => entry.jobId === job.jobId) + 1
    : null

  return {
    active: activePropertyJob
      ? {
          jobId: activePropertyJob.jobId,
          rowNumber: activePropertyJob.rowNumber,
          status: activePropertyJob.status,
          pid: activePropertyJob.pid,
          startedAt: activePropertyJob.startedAt,
        }
      : null,
    queued,
    queueDepth: propertyJobQueue.length,
    queuePosition: queuePosition > 0 ? queuePosition : null,
  }
}

function enqueuePropertyJob(payload) {
  const job = createPropertyJob(payload)
  propertyJobQueue.push(job)
  appendPropertyJobLog(
    `JOB_QUEUED job=${job.jobId} rowNumber=${job.rowNumber || ''} queuePosition=${propertyJobQueue.length} activeJob=${activePropertyJob?.jobId || ''}`,
  )
  processPropertyQueue()
  return job
}

function processPropertyQueue() {
  if (activePropertyJob || !propertyJobQueue.length) return
  const job = propertyJobQueue.shift()
  startPropertyJob(job)
}

function finishPropertyJob(job, outcome, detail = '') {
  if (job.finishedAt) return
  job.status = outcome
  job.finishedAt = new Date().toISOString()
  appendPropertyJobLog(
    `${outcome === 'COMPLETED' ? 'JOB_COMPLETED' : 'JOB_FAILED'} job=${job.jobId} rowNumber=${job.rowNumber || ''}${detail ? ` ${detail}` : ''}`,
  )

  if (activePropertyJob?.jobId === job.jobId) {
    activePropertyJob = null
  }
  processPropertyQueue()
}

function startPropertyJob(job) {
  activePropertyJob = job
  job.status = 'RUNNING'
  job.startedAt = new Date().toISOString()

  const scriptPath = path.join(rootDir, 'scripts', 'appfolio-create-property.js')
  const child = spawn(process.execPath, [scriptPath], {
    cwd: rootDir,
    env: {
      ...process.env,
      PROPERTY_ONBOARDING_PAYLOAD: JSON.stringify({ ...job.payload, jobId: job.jobId }),
    },
    windowsHide: true,
  })

  job.pid = child.pid
  let combinedOutput = ''
  appendPropertyJobLog(`JOB_STARTED job=${job.jobId} rowNumber=${job.rowNumber || ''} pid=${child.pid}`)
  appendPropertyJobLog(`START job=${job.jobId} rowNumber=${job.rowNumber || ''} pid=${child.pid}`)

  const logChunk = (streamName, chunk) => {
    const text = chunk.toString()
    combinedOutput += text
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      appendPropertyJobLog(`${streamName} job=${job.jobId} ${line}`)
    }
  }

  child.stdout.on('data', (chunk) => logChunk('stdout', chunk))
  child.stderr.on('data', (chunk) => logChunk('stderr', chunk))
  child.on('error', (error) => {
    appendPropertyJobLog(`ERROR job=${job.jobId} rowNumber=${job.rowNumber || ''} spawn failed: ${error.message}`)
    finishPropertyJob(job, 'FAILED', `spawnError="${error.message}"`)
  })
  child.on('close', (code, signal) => {
    if (code === 0 && /\bSUCCESS\b/.test(combinedOutput)) {
      appendPropertyJobLog(`SUCCESS job=${job.jobId} rowNumber=${job.rowNumber || ''} exitCode=0`)
      finishPropertyJob(job, 'COMPLETED', 'result=SUCCESS exitCode=0')
      return
    }
    if (code === 0) {
      appendPropertyJobLog(`SUCCESS job=${job.jobId} rowNumber=${job.rowNumber || ''} exitCode=0`)
      finishPropertyJob(job, 'COMPLETED', 'result=EXIT_0 exitCode=0')
      return
    }
    appendPropertyJobLog(`ERROR job=${job.jobId} rowNumber=${job.rowNumber || ''} exitCode=${code} signal=${signal || ''}`)
    finishPropertyJob(job, 'FAILED', `exitCode=${code} signal=${signal || ''}`)
  })

  child.unref()
  return job
}

async function handleApi(request, response, pathname) {
  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {})
    return true
  }

  if (pathname === '/run-property-onboarding' && request.method === 'POST') {
    const payload = await readJsonBody(request)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      sendJson(response, 400, {
        success: false,
        error: 'POST /run-property-onboarding requires one JSON object from the Property_Onboarding workflow.',
      })
      return true
    }

    const job = enqueuePropertyJob(payload)
    const queue = getPropertyQueueSnapshot(job)
    const isRunning = activePropertyJob?.jobId === job.jobId
    sendJson(response, 202, {
      success: true,
      status: isRunning ? 'STARTED' : 'QUEUED',
      message: isRunning
        ? 'Property onboarding job accepted. Playwright is running in the background.'
        : 'Property onboarding job accepted and queued. It will run after earlier AppFolio jobs finish.',
      jobId: job.jobId,
      rowNumber: job.rowNumber || null,
      pid: job.pid,
      queuePosition: isRunning ? 0 : queue.queuePosition,
      activeJobId: queue.active?.jobId || null,
      queueDepth: queue.queueDepth,
      logFile: propertyJobLogFile,
    })
    return true
  }

  if (pathname === '/run-property-onboarding/status' && request.method === 'GET') {
    sendJson(response, 200, {
      success: true,
      ...getPropertyQueueSnapshot(),
      logFile: propertyJobLogFile,
    })
    return true
  }

  return false
}

const server = http.createServer(async (request, response) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`)
  try {
    if ((pathname === '/run-property-onboarding' || pathname === '/run-property-onboarding/status') && (await handleApi(request, response, pathname))) {
      return
    }
  } catch (error) {
    sendJson(response, 400, { success: false, error: error.message })
    return
  }

  sendJson(response, 404, { success: false, error: 'Not found' })
})

server.listen(port, () => {
  console.log(`Property Onboarding automation server is running at ${appUrl}`)
  console.log(`n8n endpoint: ${appUrl}/run-property-onboarding`)
})

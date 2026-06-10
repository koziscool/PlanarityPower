const { app, BrowserWindow, Menu, ipcMain } = require('electron')
const path = require('path')
const http = require('http')
const fs = require('fs')

let win
let currentState = { ready: false, message: 'No puzzle loaded yet' }
let moveHistory = []
const STATE_PORT = 9876
const stateFilePath = path.join(__dirname, 'dashboard-state.json')
const moveHistoryFilePath = path.join(__dirname, 'move-history.jsonl')
const debugHistoryFilePath = path.join(__dirname, 'interactive-history.json')
const consolidationDemoFilePath = path.join(__dirname, 'consolidation-demo.json')

function writeState(state) {
  currentState = state
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2))
}

function resetMoveHistory() {
  moveHistory = []
  fs.writeFileSync(moveHistoryFilePath, '')
}

function appendMove(move) {
  moveHistory.push(move)
  fs.appendFileSync(moveHistoryFilePath, JSON.stringify(move) + '\n')
}

function writeDebugHistory(history) {
  fs.writeFileSync(debugHistoryFilePath, JSON.stringify(history, null, 2))
  return debugHistoryFilePath
}

// HTTP server for AI to query state
function startStateServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    const url = new URL(req.url, `http://localhost:${STATE_PORT}`)
    
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.end()
    } else if (req.method === 'GET') {
      if (url.pathname === '/state') {
        res.end(JSON.stringify(currentState, null, 2))
      } else if (url.pathname === '/history') {
        res.end(JSON.stringify(moveHistory, null, 2))
      } else if (url.pathname.startsWith('/vertex/')) {
        const idx = parseInt(url.pathname.split('/')[2])
        if (currentState.vertices && currentState.vertices[idx]) {
          res.end(JSON.stringify(currentState.vertices[idx], null, 2))
        } else {
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'Vertex not found' }))
        }
      } else if (url.pathname === '/ping') {
        res.end(JSON.stringify({ ok: true, timestamp: Date.now() }))
      } else {
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'Not found' }))
      }
    } else if (req.method === 'POST') {
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', () => {
        try {
          const payload = body ? JSON.parse(body) : {}
          if (url.pathname === '/move' && win && win.webContents) {
            const move = payload
            win.webContents.send('ai-move', move)
            res.end(JSON.stringify({ ok: true, move }))
          } else if (url.pathname === '/state') {
            writeState(payload)
            res.end(JSON.stringify({ ok: true, path: stateFilePath }))
          } else if (url.pathname === '/history/reset') {
            resetMoveHistory()
            res.end(JSON.stringify({ ok: true, path: moveHistoryFilePath }))
          } else if (url.pathname === '/history/move') {
            appendMove(payload)
            res.end(JSON.stringify({ ok: true, path: moveHistoryFilePath }))
          } else if (url.pathname === '/debug-history') {
            res.end(JSON.stringify({ ok: true, path: writeDebugHistory(payload) }))
          } else if (url.pathname === '/load-graph' && win && win.webContents) {
            const graphData = payload
            win.webContents.send('load-graph', graphData)
            res.end(JSON.stringify({ ok: true, nodes: graphData.nodes.length, edges: graphData.edges.length }))
          } else {
            res.statusCode = 404
            res.end(JSON.stringify({ error: 'Not found or no window' }))
          }
        } catch(e) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: e.message }))
        }
      })
    } else {
      res.statusCode = 405
      res.end(JSON.stringify({ error: 'Method not allowed' }))
    }
  })
  
  server.listen(STATE_PORT, '127.0.0.1', () => {
    console.log(`State server running at http://localhost:${STATE_PORT}`)
  })
}

// IPC handlers for renderer to send state
ipcMain.on('state-update', (event, state) => {
  writeState(state)
})

ipcMain.on('move-log', (event, move) => {
  appendMove(move)
})

ipcMain.on('history-reset', (event) => {
  resetMoveHistory()
})

ipcMain.handle('write-debug-history', (event, history) => {
  return writeDebugHistory(history)
})

ipcMain.handle('write-consolidation-demo', (event, demo) => {
  fs.writeFileSync(consolidationDemoFilePath, JSON.stringify(demo, null, 2))
  return consolidationDemoFilePath
})

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  win.loadFile('index.html')
  
  const menu = Menu.buildFromTemplate([
    {
      label: 'App',
      submenu: [
        { label: 'Main Game', click: () => win.loadFile('index.html') },
        { label: 'Interactive Training', click: () => win.loadFile('interactive.html') },
        { label: 'Consolidation Test', click: () => win.loadFile('testconsolidate.html') },
        { label: 'Solver Dashboard', click: () => win.loadFile('solver.html') },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win.reload() },
        { label: 'Dev Tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => win.webContents.toggleDevTools() },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }
  ])
  Menu.setApplicationMenu(menu)
}

app.whenReady().then(() => {
  startStateServer()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

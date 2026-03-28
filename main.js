const { app, BrowserWindow, Menu, ipcMain } = require('electron')
const path = require('path')
const http = require('http')

let win
let currentState = { ready: false, message: 'No puzzle loaded yet' }
let moveHistory = []
const STATE_PORT = 9876

// HTTP server for AI to query state
function startStateServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    const url = new URL(req.url, `http://localhost:${STATE_PORT}`)
    
    if (req.method === 'GET') {
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
    } else if (req.method === 'POST' && url.pathname === '/move') {
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', () => {
        try {
          const move = JSON.parse(body)
          // Forward move command to renderer
          if (win && win.webContents) {
            win.webContents.send('ai-move', move)
            res.end(JSON.stringify({ ok: true, move }))
          } else {
            res.statusCode = 500
            res.end(JSON.stringify({ error: 'No window' }))
          }
        } catch(e) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: e.message }))
        }
      })
    } else if (req.method === 'POST' && url.pathname === '/load-graph') {
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', () => {
        try {
          const graphData = JSON.parse(body)
          // Forward graph data to renderer
          if (win && win.webContents) {
            win.webContents.send('load-graph', graphData)
            res.end(JSON.stringify({ ok: true, nodes: graphData.nodes.length, edges: graphData.edges.length }))
          } else {
            res.statusCode = 500
            res.end(JSON.stringify({ error: 'No window' }))
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
  currentState = state
})

ipcMain.on('move-log', (event, move) => {
  moveHistory.push(move)
})

ipcMain.on('history-reset', (event) => {
  moveHistory = []
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

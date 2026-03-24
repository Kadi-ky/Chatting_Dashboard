import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const screenshotDir = path.join(__dirname, 'temp screenshots')

function screenshotSaverPlugin() {
  return {
    name: 'screenshot-saver',
    configureServer(server) {
      server.middlewares.use('/api/save-screenshot', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method Not Allowed')
          return
        }
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          try {
            const { filename, dataUrl } = JSON.parse(body)
            const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
            const buffer = Buffer.from(base64, 'base64')
            if (!fs.existsSync(screenshotDir)) {
              fs.mkdirSync(screenshotDir, { recursive: true })
            }
            fs.writeFileSync(path.join(screenshotDir, filename), buffer)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true, path: `temp screenshots/${filename}` }))
          } catch (err) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: err.message }))
          }
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), screenshotSaverPlugin()],
})

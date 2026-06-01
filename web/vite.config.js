import { defineConfig } from 'vite'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import fs   from 'fs'
import path from 'path'

// ─── デバッグ用: sim/ ディレクトリを /debug-sim/ として公開するプラグイン ──
// 本番ビルド (vite build) では何もしない。dev サーバーのみで動作する。
function debugSimPlugin() {
  return {
    name: 'debug-sim',
    configureServer(server) {
      const simDir = path.resolve(__dirname, '../sim')
      server.middlewares.use('/debug-sim', (req, res, _next) => {
        const file = path.join(simDir, req.url.replace(/^\/+/, ''))
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          fs.createReadStream(file).pipe(res)
        } else {
          // next() に渡すと Vite の SPA フォールバックが index.html を返してしまうため
          // ここで明示的に 404 を返す
          res.statusCode = 404
          res.end(`Not found: ${req.url}`)
        }
      })
    },
  }
}

export default defineConfig({
  // GitHub Pages では相対パスで配信するため './' を使用
  // ローカル dev サーバーでも問題なく動作する
  base: './',
  plugins: [wasm(), topLevelAwait(), debugSimPlugin()],
  optimizeDeps: {
    exclude: ['sv-wasm'],
  },
})

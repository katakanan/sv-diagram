import { defineConfig } from 'vite'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

export default defineConfig({
  // GitHub Pages では相対パスで配信するため './' を使用
  // ローカル dev サーバーでも問題なく動作する
  base: './',
  plugins: [wasm(), topLevelAwait()],
  optimizeDeps: {
    exclude: ['sv-wasm'],
  },
})

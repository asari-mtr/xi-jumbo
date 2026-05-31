import { defineConfig } from 'vite'

// GitHub Pages のプロジェクトページ（https://<user>.github.io/xi-jumbo/）で
// アセットが正しく解決されるように base を設定する。
export default defineConfig({
  base: '/xi-jumbo/',
})

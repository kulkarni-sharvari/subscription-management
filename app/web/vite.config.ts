import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // strictPort: fail instead of silently moving to another port, which would break both.
  server: {
    port: 3000,
    strictPort: true,
    // The browser calls /api on this same origin and Vite forwards it to the API. Same origin means
    // the SameSite=Strict session cookies work with no CORS in the way, as they will in production.
    proxy: { '/api': 'http://localhost:4000' },
  },
})

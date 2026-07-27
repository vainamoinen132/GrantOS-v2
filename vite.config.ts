import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split heavy vendor libraries into their own cacheable chunks so an
        // app code change doesn't bust the cache for everything, and so the
        // big export/charting libs aren't bundled into the entry chunk.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('recharts') || id.includes('/d3-')) return 'charts'
          if (id.includes('xlsx')) return 'xlsx'
          if (id.includes('jspdf') || id.includes('html2canvas')) return 'pdf'
          if (id.includes('@sentry')) return 'sentry'
          if (id.includes('@stripe')) return 'stripe'
          if (id.includes('@supabase')) return 'supabase'
          if (id.includes('/react-dom/') || id.includes('/react-router')) return 'react'
          return undefined
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: [],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})

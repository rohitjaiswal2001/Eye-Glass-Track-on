import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev:https` serves over HTTPS on your LAN so you can test on a phone
// (browsers only allow camera access on https:// or http://localhost).
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'https' ? [basicSsl()] : [])],
  server: { host: mode === 'https' ? true : undefined },
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
}));

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
  },
  server: {
    host: '0.0.0.0',   // LAN 전체에서 접근 가능 (기본값 127.0.0.1은 로컬 전용)
    open: false,        // VSCode가 포트 감지 시 브라우저를 반복 실행하는 것 방지
    port: parseInt(process.env.VITE_PORT || '5173'),
    proxy: {
      '/api': `http://localhost:${process.env.BACKEND_PORT || '3001'}`,
      '/socket.io': {
        target: `http://localhost:${process.env.BACKEND_PORT || '3001'}`,
        ws: true,
      },
    },
  },
});

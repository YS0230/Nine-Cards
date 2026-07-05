import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 前端連到 server 的位址（同機不同埠）；正式部署時可用 VITE_SERVER_URL 覆寫
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // 允許同網段手機用 LAN IP 連入測試
    port: 5173,
  },
});

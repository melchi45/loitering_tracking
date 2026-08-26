import { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../stores/authStore';

// Use same origin so port-forwarding / reverse-proxy setups work correctly
const SOCKET_URL = import.meta.env.VITE_API_URL || window.location.origin;

// Singleton socket instance
let socketInstance: Socket | null = null;

function getSocket(): Socket {
  if (!socketInstance) {
    socketInstance = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      // Server-side io.use() (server/src/index.js, 2026-08-25 — see
      // docs/design/Design_RTSP_Over_WebSocket.md §8.24) now requires a
      // valid accessToken on every (re)connection attempt. The function
      // form of `auth` is re-invoked on each attempt (initial connect and
      // every automatic reconnect), so it always reads the CURRENT token
      // from authStore rather than one captured at module-load time — a
      // socket created before login (token null, rejected by the server)
      // picks up a real token on its next automatic retry once login
      // completes, without needing any extra reconnect-nudging here.
      auth: (cb) => cb({ token: useAuthStore.getState().accessToken }),
    });
  }
  return socketInstance;
}

export { getSocket };

export function useSocket() {
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket>(getSocket());

  useEffect(() => {
    const socket = socketRef.current;

    const handleConnect = () => setConnected(true);
    const handleDisconnect = () => setConnected(false);

    // Set initial state
    setConnected(socket.connected);

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
    };
  }, []);

  return { socket: socketRef.current, connected };
}

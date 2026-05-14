import { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

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
    });
  }
  return socketInstance;
}

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

import { Server } from 'http';
import WebSocket from 'ws';

export const initializeWebsocket = (expressServer: Server) => {
  const websocketServer = new WebSocket.Server({
    noServer: true,
    path: '/api/ws',
  });

  expressServer.on('upgrade', (request, socket, head) => {
    if(request.headers["key"] !== process.env.SECRET_KEY) return;
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit('connection', websocket, request);
    });
  });

  return websocketServer;
};

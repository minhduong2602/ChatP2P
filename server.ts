import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { createServer } from "http";
import { Server } from "socket.io";

async function startServer() {
  const app = express();
  const PORT = 3000;
  const httpServer = createServer(app);
  
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    socket.on("join-room", (roomId: string) => {
      socket.join(roomId);
      const room = io.sockets.adapter.rooms.get(roomId);
      const numClients = room ? room.size : 0;
      
      console.log(`[Signaling] Socket ${socket.id} joined room ${roomId} (total users: ${numClients})`);
      
      // Notify the joining client about their room state
      socket.emit("room-joined", { roomId, numClients });

      // If another user is already in the room, tell them a peer joined so they can initiate the offer
      if (numClients > 1) {
        socket.to(roomId).emit("peer-joined", { peerId: socket.id });
      }
    });

    socket.on("offer", (roomId: string, offer: any) => {
      console.log(`[Signaling] Relaying offer in room ${roomId} from ${socket.id}`);
      socket.to(roomId).emit("offer", offer);
    });

    socket.on("answer", (roomId: string, answer: any) => {
      console.log(`[Signaling] Relaying answer in room ${roomId} from ${socket.id}`);
      socket.to(roomId).emit("answer", answer);
    });

    socket.on("candidate", (roomId: string, candidate: any) => {
      socket.to(roomId).emit("candidate", candidate);
    });

    socket.on("request-offer", (roomId: string) => {
      console.log(`[Signaling] Peer ${socket.id} requested offer in room ${roomId}`);
      socket.to(roomId).emit("peer-joined", { peerId: socket.id });
    });

    socket.on("leave-room", (roomId: string) => {
      socket.leave(roomId);
      socket.to(roomId).emit("peer-disconnected", { peerId: socket.id });
    });

    socket.on("disconnecting", () => {
      for (const roomId of socket.rooms) {
        if (roomId !== socket.id) {
          socket.to(roomId).emit("peer-disconnected", { peerId: socket.id });
        }
      }
    });

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

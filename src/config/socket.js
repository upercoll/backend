const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const ChatMessage = require("../models/ChatMessage");
const ClaimSession = require("../models/ClaimSession");
const Order = require("../models/Order");
const AgentStats = require("../models/AgentStats");
const AdminProfile = require("../models/AdminProfile");
const { sendAgentReplyNotificationEmail } = require("./email");
const logger = require("../utils/logger");

let io;

const agentQueues = new Map();
const agentSockets = new Map();

function getAgentsForGame(game) {
  return agentQueues.get(game) || [];
}

function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: [
        process.env.FRONTEND_URL,
        "http://localhost:5173",
        "http://localhost:5000",
      ].filter(Boolean),
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (token) {
      try {
        socket.user = jwt.verify(token, process.env.JWT_SECRET);
      } catch {}
    }
    next();
  });

  io.on("connection", (socket) => {
    const sessionId = socket.handshake.query.sessionId || socket.id;
    logger.info(`Socket connected: ${sessionId}`);

    socket.join(`session:${sessionId}`);

    if (socket.user?.role === "admin" || socket.user?.type === "owner" || socket.user?.isOwner === true) {
      socket.join("admin-room");
      logger.info(`Admin joined admin-room: ${socket.user.email}`);
    }

    socket.on("user:message", async (data) => {
      try {
        const msg = await ChatMessage.create({
          sessionId,
          sender: "user",
          text: data.text?.slice(0, 1000),
          userName: data.userName || "User",
          read: false,
        });
        io.to("admin-room").emit("admin:new_message", { ...msg.toObject(), socketId: socket.id });
        socket.emit("user:message_saved", msg.toObject());
      } catch (err) {
        logger.error("user:message error:", err);
        socket.emit("error", { message: "Failed to send message" });
      }
    });

    socket.on("admin:reply", async (data) => {
      if (socket.user?.role !== "admin" && socket.user?.type !== "owner") return;
      try {
        const msg = await ChatMessage.create({
          sessionId: data.sessionId,
          sender: "admin",
          text: data.text?.slice(0, 1000),
          userName: "RBstars Support",
          read: true,
        });
        io.to(`session:${data.sessionId}`).emit("user:admin_reply", msg.toObject());
        io.to("admin-room").emit("admin:reply_sent", msg.toObject());
      } catch (err) {
        logger.error("admin:reply error:", err);
      }
    });

    socket.on("admin:mark_read", async ({ sessionId: sid }) => {
      if (socket.user?.role !== "admin" && socket.user?.type !== "owner") return;
      await ChatMessage.updateMany({ sessionId: sid, read: false }, { read: true });
      io.to("admin-room").emit("admin:session_read", { sessionId: sid });
    });

    socket.on("user:typing", () => {
      io.to("admin-room").emit("admin:user_typing", { sessionId });
    });

    socket.on("admin:typing", (data) => {
      if (socket.user?.role !== "admin" && socket.user?.type !== "owner") return;
      io.to(`session:${data.sessionId}`).emit("user:admin_typing");
    });

    socket.on("claim:join", async ({ roomId }) => {
      if (!roomId) return;
      socket.join(`claim:${roomId}`);
      socket.claimRoomId = roomId;
      logger.info(`Customer joined claim room: ${roomId}`);
    });

    socket.on("claim:agent_browse", async ({ roomId }) => {
      if (!roomId) return;
      socket.join(`claim:${roomId}`);
      logger.info(`Agent browsing claim room: ${roomId}`);
    });

    socket.on("claim:agent_join", async ({ roomId, agentName }) => {
      if (!roomId) return;
      socket.join(`claim:${roomId}`);
      socket.claimRoomId = roomId;

      const displayName = agentName || socket.user?.name || "Support Agent";

      try {
        const session = await ClaimSession.findOne({ roomId });
        if (!session) return;

        if (session.status === "pending") {
          session.status = "active";
          session.assignedAgent = {
            userId: socket.user?._id || socket.panelUserId || null,
            name: displayName,
            joinedAt: new Date(),
          };
          const joinMsg = {
            sender: "system",
            text: `${displayName} has joined the chat`,
            senderName: "System",
            timestamp: new Date(),
          };
          session.messages.push(joinMsg);
          await session.save();

          io.to(`claim:${roomId}`).emit("claim:agent_joined", {
            agentName: displayName,
            message: `${displayName} has joined the chat`,
          });

          io.to("admin-room").emit("admin:claim_status_changed", {
            roomId,
            status: "active",
            agentName: displayName,
          });
        }
      } catch (err) {
        logger.error("claim:agent_join error:", err);
      }
    });

    socket.on("claim:message", async ({ roomId, text, senderName, sender }) => {
      if (!roomId || !text?.trim()) return;
      try {
        const session = await ClaimSession.findOne({ roomId });
        if (!session || session.status === "ended") return;

        const isAgentUser = socket.user || socket.panelUserId;
        const msgSender = sender === "agent" && isAgentUser ? "agent" : "customer";
        const name = senderName || (msgSender === "agent" ? (socket.user?.name || "Agent") : "Customer");

        let autoClaimed = false;

        if (msgSender === "agent" && session.status === "pending") {
          const agentId = socket.panelUserId || socket.user?.id || socket.user?._id;
          const agentDisplayName = senderName || socket.agentName || socket.user?.displayName || "Agent";

          session.status = "active";
          session.assignedAgent = {
            userId: agentId || null,
            name: agentDisplayName,
            joinedAt: new Date(),
          };

          const joinMsg = {
            sender: "system",
            text: `${agentDisplayName} has joined the chat`,
            senderName: "System",
            timestamp: new Date(),
          };
          session.messages.push(joinMsg);
          autoClaimed = true;

          AgentStats.findOneAndUpdate(
            { agentId: agentId },
            { $inc: { totalClaims: 1 }, lastSeen: new Date() },
            { upsert: true }
          ).catch(() => {});
        }

        const msg = {
          sender: msgSender,
          text: text.slice(0, 2000),
          senderName: name,
          timestamp: new Date(),
        };

        session.messages.push(msg);

        const isFirstAgentReply = msgSender === "agent" && !session.firstAgentReplyAt;
        if (isFirstAgentReply) {
          session.firstAgentReplyAt = new Date();
        }

        await session.save();
        const savedMsg = session.messages[session.messages.length - 1];
        const savedMsgObj = savedMsg.toObject();

        if (autoClaimed) {
          const joinSysMsg = session.messages[session.messages.length - 2];
          socket.to(`claim:${roomId}`).emit("claim:agent_joined", {
            agentName: session.assignedAgent.name,
            message: `${session.assignedAgent.name} has joined the chat`,
          });
          socket.to(`claim:${roomId}`).emit("claim:new_message", {
            ...joinSysMsg.toObject(),
            roomId,
          });
          io.to("agent-queue-room").emit("queue:claim_taken", {
            roomId,
            agentId: socket.panelUserId || socket.user?.id,
            agentName: session.assignedAgent.name,
          });
          socket.emit("queue:claim_auto_assigned", {
            roomId,
            session: session.toObject(),
          });
          io.to("admin-room").emit("admin:claim_status_changed", {
            roomId,
            status: "active",
            agentName: session.assignedAgent.name,
            agentId: socket.panelUserId || socket.user?.id,
          });
        }

        socket.to(`claim:${roomId}`).emit("claim:new_message", { ...savedMsgObj, roomId });
        socket.emit("claim:message_ack", { ...savedMsgObj, roomId });

        if (msgSender === "customer") {
          io.to("admin-room").emit("admin:claim_message", {
            roomId,
            senderName: name,
            text: text.slice(0, 100),
          });
          io.to("agent-queue-room").emit("queue:customer_message", {
            roomId,
            senderName: name,
            text: text.slice(0, 100),
          });
        }

        if (isFirstAgentReply) {
          try {
            const agentUserId = session.assignedAgent?.userId || socket.panelUserId || null;
            let agentProfile = null;
            if (agentUserId) {
              agentProfile = await AdminProfile.findOne({ memberId: agentUserId });
            }
            const frontendUrl = process.env.FRONTEND_URL || "https://rbstars.gg";
            sendAgentReplyNotificationEmail({
              to: session.contactEmail,
              orderRef: session.orderRef || null,
              agentName: session.assignedAgent?.name || name,
              agentPicture: agentProfile?.profilePicture || null,
              agentBio: agentProfile?.bio || null,
              roomId: session.roomId,
              frontendUrl,
            }).catch((emailErr) => logger.warn("Agent reply email failed:", emailErr.message));
          } catch (emailErr) {
            logger.warn("Failed to trigger agent reply email:", emailErr.message);
          }
        }
      } catch (err) {
        logger.error("claim:message error:", err);
      }
    });

    socket.on("claim:typing", ({ roomId, senderName }) => {
      if (!roomId) return;
      socket.to(`claim:${roomId}`).emit("claim:typing", { senderName });
    });

    socket.on("claim:update_user_info", async ({ roomId, robloxUsername, contactEmail }) => {
      if (!roomId) return;
      try {
        const session = await ClaimSession.findOne({ roomId });
        if (!session || session.status !== "pending") return;

        const changes = [];

        if (robloxUsername?.trim() && robloxUsername.trim() !== session.robloxUsername) {
          const oldName = session.robloxUsername;
          session.robloxUsername = robloxUsername.trim();
          changes.push(`${oldName} changed their Roblox username to ${robloxUsername.trim()}`);
        }

        if (
          contactEmail?.trim() &&
          contactEmail.includes("@") &&
          contactEmail.trim().toLowerCase() !== session.contactEmail
        ) {
          const newEmail = contactEmail.trim().toLowerCase();
          session.contactEmail = newEmail;
          changes.push(`User updated their contact email to ${newEmail}`);
        }

        if (changes.length === 0) return;

        for (const text of changes) {
          session.messages.push({ sender: "system", text, senderName: "System" });
        }
        await session.save();

        for (const text of changes) {
          io.to(`claim:${roomId}`).emit("claim:new_message", {
            sender: "system",
            text,
            senderName: "System",
            timestamp: new Date(),
            roomId,
          });
        }
        io.to("admin-room").emit("admin:claim_user_info_updated", {
          roomId,
          robloxUsername: session.robloxUsername,
          contactEmail: session.contactEmail,
        });
      } catch (err) {
        logger.error("claim:update_user_info error:", err);
      }
    });

    socket.on("claim:end", async ({ roomId }) => {
      if (!roomId) return;
      try {
        const session = await ClaimSession.findOne({ roomId });
        if (!session) return;
        session.status = "ended";
        session.resolvedAt = new Date();
        session.messages.push({
          sender: "system",
          text: "The support agent has ended the chat. Thank you for your patience!",
          senderName: "System",
          timestamp: new Date(),
        });
        await session.save();

        io.to(`claim:${roomId}`).emit("claim:ended", {
          message: "The support agent has ended the chat. Thank you!",
        });
        io.to("admin-room").emit("admin:claim_status_changed", { roomId, status: "ended" });
        io.to("agent-queue-room").emit("queue:claim_ended", {
          roomId,
          agentId: session.assignedAgent?.userId,
        });
      } catch (err) {
        logger.error("claim:end error:", err);
      }
    });

    socket.on("claim:mark_claimed", async ({ roomId }) => {
      if (!roomId) return;
      try {
        const session = await ClaimSession.findOne({ roomId });
        if (!session) return;
        session.status = "claimed";
        session.resolvedAt = new Date();
        session.messages.push({
          sender: "system",
          text: "Your order has been delivered! Items should be in your inventory.",
          senderName: "System",
          timestamp: new Date(),
        });
        await session.save();

        if (session.assignedAgent?.userId) {
          AgentStats.findOneAndUpdate(
            { agentId: session.assignedAgent.userId },
            { $inc: { completedClaims: 1 } },
            { upsert: true }
          ).catch(() => {});
        }

        if (session.orderRef) {
          try {
            const linkedOrder = await Order.findOne({ orderNumber: session.orderRef });
            const terminalStatuses = ["fulfilled", "cancelled", "refunded", "partially_refunded"];
            if (linkedOrder && !terminalStatuses.includes(linkedOrder.status)) {
              linkedOrder.status = "fulfilled";
              linkedOrder.fulfillmentStatus = "fulfilled";
              linkedOrder.fulfilledAt = new Date();
              linkedOrder.fulfilledBy = session.assignedAgent?.name || "Claim Agent";
              linkedOrder.delivery.status = "delivered";
              linkedOrder.delivery.deliveredAt = new Date();
              if (!linkedOrder.timeline) linkedOrder.timeline = [];
              linkedOrder.timeline.push({
                action: "Order auto-fulfilled via claim chat",
                by: session.assignedAgent?.name || "Claim Agent",
                details: `Claim session ${session.roomId} marked as delivered`,
                timestamp: new Date(),
              });
              await linkedOrder.save();
              io.to("admin-room").emit("admin:order_fulfilled", {
                orderNumber: session.orderRef,
                fulfilledBy: session.assignedAgent?.name || "Claim Agent",
              });
            }
          } catch (orderErr) {
            logger.error("Failed to auto-fulfill order from claim:", orderErr);
          }
        }

        io.to(`claim:${roomId}`).emit("claim:marked_claimed", {
          message: "Your order has been delivered! Check your inventory.",
        });
        io.to("admin-room").emit("admin:claim_status_changed", { roomId, status: "claimed" });
        io.to("agent-queue-room").emit("queue:claim_completed", {
          roomId,
          agentId: session.assignedAgent?.userId,
          agentName: session.assignedAgent?.name,
          itemName: session.itemName,
          game: session.game,
        });
      } catch (err) {
        logger.error("claim:mark_claimed error:", err);
      }
    });

    socket.on("queue:join", ({ games, agentId, agentName }) => {
      if (!Array.isArray(games)) return;

      socket.panelUserId = agentId;
      socket.agentName = agentName;
      socket.join("agent-queue-room");

      agentSockets.set(agentId, socket.id);

      for (const game of games) {
        if (!agentQueues.has(game)) agentQueues.set(game, []);
        const queue = agentQueues.get(game);
        if (!queue.includes(socket.id)) queue.push(socket.id);
      }

      AgentStats.findOneAndUpdate(
        { agentId },
        { isOnline: true, currentSessionStart: new Date(), lastSeen: new Date() },
        { upsert: true }
      ).catch(() => {});

      io.to("admin-room").emit("admin:agent_online", { agentId, agentName, games });
      logger.info(`Agent ${agentId} joined queue for games: ${games.join(", ")}`);
    });

    socket.on("queue:leave", ({ agentId }) => {
      for (const [, queue] of agentQueues.entries()) {
        const idx = queue.indexOf(socket.id);
        if (idx !== -1) queue.splice(idx, 1);
      }
      if (agentId) {
        agentSockets.delete(agentId);
        AgentStats.findOneAndUpdate(
          { agentId },
          { isOnline: false, lastSeen: new Date() },
          { upsert: true }
        ).catch(() => {});
      }
      io.to("admin-room").emit("admin:agent_offline", { agentId });
    });

    socket.on("disconnect", () => {
      logger.info(`Socket disconnected: ${sessionId}`);

      for (const [, queue] of agentQueues.entries()) {
        const idx = queue.indexOf(socket.id);
        if (idx !== -1) queue.splice(idx, 1);
      }

      if (socket.panelUserId) {
        agentSockets.delete(socket.panelUserId);
        AgentStats.findOneAndUpdate(
          { agentId: socket.panelUserId },
          { isOnline: false, lastSeen: new Date() },
          { upsert: true }
        ).catch(() => {});
        io.to("admin-room").emit("admin:agent_offline", { agentId: socket.panelUserId });
      }

      if (!socket.user?.role && !socket.panelUserId) {
        io.to("admin-room").emit("admin:user_offline", { sessionId });
      }

      if (socket.claimRoomId) {
        io.to("admin-room").emit("admin:claim_customer_offline", { roomId: socket.claimRoomId });
      }
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error("Socket.io not initialised");
  return io;
}

function notifyNewClaim(sessionData) {
  if (!io) return;
  const game = sessionData.game;

  let agents = getAgentsForGame(game);

  if (agents.length === 0) {
    const seen = new Set();
    const all = [];
    for (const queue of agentQueues.values()) {
      for (const id of queue) {
        if (!seen.has(id)) { seen.add(id); all.push(id); }
      }
    }
    agents = all;
    logger.info(`No agents for game "${game}", falling back to all ${agents.length} available agents`);
  }

  if (agents.length > 0) {
    for (const socketId of agents) {
      const targetSocket = io.sockets.sockets.get(socketId);
      if (targetSocket) {
        targetSocket.emit("queue:new_pending_claim", sessionData);
      }
    }
    logger.info(`Notified ${agents.length} agents of new claim ${sessionData.roomId}`);
  } else {
    logger.info(`No agents online for claim ${sessionData.roomId}`);
  }

  io.to("admin-room").emit("admin:new_claim", sessionData);
}

module.exports = { initSocket, getIO, notifyNewClaim };

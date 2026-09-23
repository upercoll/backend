const { v4: uuidv4 } = require("uuid");
const Ticket = require("../models/Ticket");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const logger = require("../utils/logger");

function tryGetIO() {
  try {
    return require("../config/socket").getIO();
  } catch {
    return null;
  }
}

exports.createTicket = catchAsync(async (req, res, next) => {
  const { subject, category, customerEmail, customerName, orderId, initialMessage } = req.body;

  if (!subject?.trim()) return next(new AppError("Subject is required", 400));
  if (!customerEmail?.includes("@")) return next(new AppError("Valid email is required", 400));

  const ticketId = uuidv4();
  const emailLower = customerEmail.trim().toLowerCase();

  const messages = [];
  if (initialMessage?.trim()) {
    messages.push({
      sender: "customer",
      text: initialMessage.trim().slice(0, 2000),
      senderName: customerName || "Customer",
      timestamp: new Date(),
    });
  }

  messages.push({
    sender: "system",
    text: "Ticket created. Our team will get back to you shortly.",
    senderName: "System",
    timestamp: new Date(),
  });

  const ticket = await Ticket.create({
    ticketId,
    subject: subject.trim(),
    category: category || "general",
    customerEmail: emailLower,
    customerName: customerName?.trim() || undefined,
    orderId: orderId?.trim() || undefined,
    messages,
    lastReplyAt: new Date(),
    unreadAgent: messages.length > 0 ? 1 : 0,
  });

  try {
    const io = tryGetIO();
    if (io) {
      io.to("support-room").emit("ticket:new", {
        ticketId: ticket.ticketId,
        subject: ticket.subject,
        category: ticket.category,
        status: ticket.status,
        priority: ticket.priority,
        customerEmail: ticket.customerEmail,
        customerName: ticket.customerName,
        createdAt: ticket.createdAt,
      });
    }
  } catch {}

  logger.info(`New ticket: ${ticketId} from ${emailLower} — ${subject.trim()}`);

  res.status(201).json({
    success: true,
    data: {
      ticketId: ticket.ticketId,
      subject: ticket.subject,
      category: ticket.category,
      status: ticket.status,
      priority: ticket.priority,
      messages: ticket.messages,
      createdAt: ticket.createdAt,
    },
  });
});

exports.getMyTickets = catchAsync(async (req, res, next) => {
  const email = req.query.email;
  if (!email?.includes("@")) return next(new AppError("Valid email is required", 400));

  const tickets = await Ticket.find({ customerEmail: email.trim().toLowerCase() })
    .sort({ createdAt: -1 })
    .select("-messages -__v");

  res.json({ success: true, data: { tickets } });
});

exports.getTicket = catchAsync(async (req, res, next) => {
  const { ticketId } = req.params;
  const email = req.query.email;
  if (!email?.includes("@")) return next(new AppError("Valid email is required", 400));

  const ticket = await Ticket.findOne({ ticketId }).select("-__v");
  if (!ticket) return next(new AppError("Ticket not found", 404));

  if (ticket.customerEmail !== email.trim().toLowerCase()) {
    return next(new AppError("Unauthorized", 403));
  }

  res.json({
    success: true,
    data: {
      ticketId: ticket.ticketId,
      subject: ticket.subject,
      category: ticket.category,
      status: ticket.status,
      priority: ticket.priority,
      messages: ticket.messages,
      tags: ticket.tags,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
    },
  });
});

exports.addMessage = catchAsync(async (req, res, next) => {
  const { ticketId, customerEmail, text } = req.body;

  if (!ticketId) return next(new AppError("ticketId is required", 400));
  if (!customerEmail?.includes("@")) return next(new AppError("Valid email is required", 400));
  if (!text?.trim()) return next(new AppError("Message text is required", 400));

  const ticket = await Ticket.findOne({ ticketId });
  if (!ticket) return next(new AppError("Ticket not found", 404));

  if (ticket.customerEmail !== customerEmail.trim().toLowerCase()) {
    return next(new AppError("Unauthorized", 403));
  }

  if (ticket.status === "closed") {
    return next(new AppError("This ticket is closed", 400));
  }

  const msg = {
    sender: "customer",
    text: text.trim().slice(0, 2000),
    senderName: ticket.customerName || "Customer",
    timestamp: new Date(),
  };

  ticket.messages.push(msg);
  ticket.unreadAgent = (ticket.unreadAgent || 0) + 1;
  ticket.lastReplyAt = new Date();

  if (ticket.status === "resolved" || ticket.status === "waiting") {
    ticket.status = "in_progress";
  }

  await ticket.save();

  const savedMsg = ticket.messages[ticket.messages.length - 1];

  try {
    const io = tryGetIO();
    if (io) {
      io.to("support-room").emit("ticket:message", {
        ticketId,
        message: savedMsg.toObject(),
      });
      if (ticket.assignedAgent?.userId) {
        io.to(`ticket:agent:${ticket.assignedAgent.userId}`).emit("ticket:update", {
          ticketId,
          type: "new_message",
        });
      }
    }
  } catch {}

  res.json({ success: true, data: { message: savedMsg } });
});

exports.closeTicket = catchAsync(async (req, res, next) => {
  const { ticketId, customerEmail } = req.body;

  if (!ticketId) return next(new AppError("ticketId is required", 400));
  if (!customerEmail?.includes("@")) return next(new AppError("Valid email is required", 400));

  const ticket = await Ticket.findOne({ ticketId });
  if (!ticket) return next(new AppError("Ticket not found", 404));

  if (ticket.customerEmail !== customerEmail.trim().toLowerCase()) {
    return next(new AppError("Unauthorized", 403));
  }

  ticket.status = "closed";
  ticket.closedAt = new Date();
  ticket.messages.push({
    sender: "system",
    text: "Customer closed this ticket.",
    senderName: "System",
    timestamp: new Date(),
  });
  await ticket.save();

  try {
    const io = tryGetIO();
    if (io) {
      io.to("support-room").emit("ticket:update", { ticketId, type: "closed" });
      if (ticket.assignedAgent?.userId) {
        io.to(`ticket:agent:${ticket.assignedAgent.userId}`).emit("ticket:update", {
          ticketId,
          type: "closed",
        });
      }
    }
  } catch {}

  res.json({ success: true, data: { ticketId, status: "closed" } });
});

exports.listAgentTickets = catchAsync(async (req, res) => {
  const { status, assignedTo, page = 1, limit = 30 } = req.query;
  const agentId = req.panelUser?._id || req.panelUser?.id;

  const filter = {};
  if (status) {
    filter.status = status;
  } else {
    filter.$or = [
      { status: { $in: ["open", "in_progress", "waiting"] } },
      { "assignedAgent.userId": agentId },
    ];
  }

  if (assignedTo) {
    filter["assignedAgent.userId"] = assignedTo;
  }

  const tickets = await Ticket.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit))
    .select("-messages -__v");

  const total = await Ticket.countDocuments(filter);

  res.json({ success: true, total, data: tickets });
});

exports.getTicketFull = catchAsync(async (req, res, next) => {
  const ticket = await Ticket.findOne({ ticketId: req.params.ticketId });
  if (!ticket) return next(new AppError("Ticket not found", 404));

  res.json({ success: true, data: ticket });
});

exports.assignTicket = catchAsync(async (req, res, next) => {
  const { agentId } = req.body;
  const ticket = await Ticket.findOne({ ticketId: req.params.ticketId });
  if (!ticket) return next(new AppError("Ticket not found", 404));

  ticket.assignedAgent = {
    userId: agentId,
    name: req.body.agentName || req.panelUser?.name || "Agent",
    assignedAt: new Date(),
  };
  if (ticket.status === "open") ticket.status = "in_progress";

  ticket.messages.push({
    sender: "system",
    text: `Ticket assigned to ${ticket.assignedAgent.name}`,
    senderName: "System",
    timestamp: new Date(),
  });
  await ticket.save();

  try {
    const io = tryGetIO();
    if (io) {
      io.to("support-room").emit("ticket:update", {
        ticketId: ticket.ticketId,
        type: "assigned",
        agentId,
        agentName: ticket.assignedAgent.name,
      });
      io.to(`ticket:agent:${agentId}`).emit("ticket:assigned", {
        ticketId: ticket.ticketId,
        subject: ticket.subject,
        priority: ticket.priority,
      });
    }
  } catch {}

  res.json({
    success: true,
    data: { ticketId: ticket.ticketId, assignedAgent: ticket.assignedAgent },
  });
});

exports.agentReply = catchAsync(async (req, res, next) => {
  const { text } = req.body;
  if (!text?.trim()) return next(new AppError("Message text is required", 400));

  const ticket = await Ticket.findOne({ ticketId: req.params.ticketId });
  if (!ticket) return next(new AppError("Ticket not found", 404));

  const agentName = req.panelUser?.name || "Agent";
  const msg = {
    sender: "agent",
    text: text.trim().slice(0, 2000),
    senderName: agentName,
    timestamp: new Date(),
  };

  ticket.messages.push(msg);
  ticket.unreadCustomer = (ticket.unreadCustomer || 0) + 1;
  ticket.lastReplyAt = new Date();
  await ticket.save();

  const savedMsg = ticket.messages[ticket.messages.length - 1];

  try {
    const io = tryGetIO();
    if (io) {
      io.to("support-room").emit("ticket:message", {
        ticketId: ticket.ticketId,
        message: savedMsg.toObject(),
      });
    }
  } catch {}

  res.json({ success: true, data: { message: savedMsg } });
});

exports.updateTicketStatus = catchAsync(async (req, res, next) => {
  const { status } = req.body;
  const allowed = ["open", "in_progress", "waiting", "resolved", "closed"];
  if (!allowed.includes(status)) return next(new AppError(`Status must be one of: ${allowed.join(", ")}`, 400));

  const ticket = await Ticket.findOne({ ticketId: req.params.ticketId });
  if (!ticket) return next(new AppError("Ticket not found", 404));

  ticket.status = status;
  if (status === "closed") ticket.closedAt = new Date();
  if (status === "resolved") ticket.resolvedAt = new Date();

  ticket.messages.push({
    sender: "system",
    text: `Status changed to ${status}`,
    senderName: "System",
    timestamp: new Date(),
  });
  await ticket.save();

  try {
    const io = tryGetIO();
    if (io) {
      io.to("support-room").emit("ticket:update", {
        ticketId: ticket.ticketId,
        type: "status_changed",
        status,
      });
      if (ticket.assignedAgent?.userId) {
        io.to(`ticket:agent:${ticket.assignedAgent.userId}`).emit("ticket:update", {
          ticketId: ticket.ticketId,
          type: "status_changed",
          status,
        });
      }
    }
  } catch {}

  res.json({ success: true, data: { ticketId: ticket.ticketId, status: ticket.status } });
});

exports.updateTicketPriority = catchAsync(async (req, res, next) => {
  const { priority } = req.body;
  const allowed = ["low", "medium", "high", "urgent"];
  if (!allowed.includes(priority)) return next(new AppError(`Priority must be one of: ${allowed.join(", ")}`, 400));

  const ticket = await Ticket.findOne({ ticketId: req.params.ticketId });
  if (!ticket) return next(new AppError("Ticket not found", 404));

  ticket.priority = priority;
  await ticket.save();

  try {
    const io = tryGetIO();
    if (io) {
      io.to("support-room").emit("ticket:update", {
        ticketId: ticket.ticketId,
        type: "priority_changed",
        priority,
      });
    }
  } catch {}

  res.json({ success: true, data: { ticketId: ticket.ticketId, priority: ticket.priority } });
});

exports.addTag = catchAsync(async (req, res, next) => {
  const { tag } = req.body;
  if (!tag?.trim()) return next(new AppError("Tag is required", 400));

  const ticket = await Ticket.findOne({ ticketId: req.params.ticketId });
  if (!ticket) return next(new AppError("Ticket not found", 404));

  const trimmed = tag.trim();
  if (!ticket.tags.includes(trimmed)) {
    ticket.tags.push(trimmed);
    await ticket.save();
  }

  res.json({ success: true, data: { ticketId: ticket.ticketId, tags: ticket.tags } });
});

exports.resolveTicket = catchAsync(async (req, res, next) => {
  const { resolution } = req.body;
  if (!resolution?.trim()) return next(new AppError("Resolution text is required", 400));

  const ticket = await Ticket.findOne({ ticketId: req.params.ticketId });
  if (!ticket) return next(new AppError("Ticket not found", 404));

  ticket.status = "resolved";
  ticket.resolution = resolution.trim();
  ticket.resolvedAt = new Date();
  ticket.messages.push({
    sender: "system",
    text: `Ticket resolved: ${resolution.trim()}`,
    senderName: "System",
    timestamp: new Date(),
  });
  await ticket.save();

  try {
    const io = tryGetIO();
    if (io) {
      io.to("support-room").emit("ticket:update", {
        ticketId: ticket.ticketId,
        type: "resolved",
      });
    }
  } catch {}

  res.json({ success: true, data: { ticketId: ticket.ticketId, status: "resolved" } });
});

exports.closeTicketByAgent = catchAsync(async (req, res, next) => {
  const ticket = await Ticket.findOne({ ticketId: req.params.ticketId });
  if (!ticket) return next(new AppError("Ticket not found", 404));

  ticket.status = "closed";
  ticket.closedAt = new Date();
  ticket.messages.push({
    sender: "system",
    text: "Ticket closed by agent.",
    senderName: "System",
    timestamp: new Date(),
  });
  await ticket.save();

  try {
    const io = tryGetIO();
    if (io) {
      io.to("support-room").emit("ticket:update", {
        ticketId: ticket.ticketId,
        type: "closed",
      });
    }
  } catch {}

  res.json({ success: true, data: { ticketId: ticket.ticketId, status: "closed" } });
});

exports.getTicketStats = catchAsync(async (req, res) => {
  const [open, inProgress, waiting, resolved, closed] = await Promise.all([
    Ticket.countDocuments({ status: "open" }),
    Ticket.countDocuments({ status: "in_progress" }),
    Ticket.countDocuments({ status: "waiting" }),
    Ticket.countDocuments({ status: "resolved" }),
    Ticket.countDocuments({ status: "closed" }),
  ]);

  res.json({
    success: true,
    data: {
      open,
      inProgress,
      waiting,
      resolved,
      closed,
      total: open + inProgress + waiting + resolved + closed,
    },
  });
});

exports.deleteTicket = catchAsync(async (req, res, next) => {
  if (!req.panelUser.isOwner) return next(new AppError("Owner access required", 403));

  const ticket = await Ticket.findOne({ ticketId: req.params.ticketId });
  if (!ticket) return next(new AppError("Ticket not found", 404));

  await ticket.deleteOne();

  try {
    const io = tryGetIO();
    if (io) {
      io.to("support-room").emit("ticket:update", {
        ticketId: ticket.ticketId,
        type: "deleted",
      });
    }
  } catch {}

  logger.info(`Owner deleted ticket ${ticket.ticketId}`);
  res.json({ success: true, message: "Ticket deleted" });
});

exports.customerUnreadCount = catchAsync(async (req, res, next) => {
  const email = req.query.email;
  if (!email?.includes("@")) return next(new AppError("Valid email is required", 400));

  const result = await Ticket.aggregate([
    {
      $match: {
        customerEmail: email.trim().toLowerCase(),
        status: { $in: ["open", "in_progress", "waiting"] },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: "$unreadCustomer" },
      },
    },
  ]);

  const total = result.length > 0 ? result[0].total : 0;
  res.json({ success: true, data: { total } });
});

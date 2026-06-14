const ChatMessage = require("../models/ChatMessage");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

exports.getSessionHistory = catchAsync(async (req, res, next) => {
  const { sessionId } = req.params;

  if (req.user?.role !== "admin" && req.query.sessionId && req.query.sessionId !== sessionId) {
    return next(new AppError("Access denied", 403));
  }

  const messages = await ChatMessage.find({ sessionId })
    .sort("createdAt")
    .limit(200);

  res.json({ success: true, count: messages.length, data: messages });
});

exports.getAllSessions = catchAsync(async (req, res) => {
  const sessions = await ChatMessage.aggregate([
    {
      $group: {
        _id: "$sessionId",
        lastMessage: { $last: "$text" },
        lastSender: { $last: "$sender" },
        lastAt: { $last: "$createdAt" },
        unread: {
          $sum: { $cond: [{ $and: [{ $eq: ["$sender", "user"] }, { $eq: ["$read", false] }] }, 1, 0] },
        },
        messageCount: { $sum: 1 },
        userName: { $last: "$userName" },
      },
    },
    { $sort: { lastAt: -1 } },
    { $limit: 100 },
  ]);

  res.json({ success: true, count: sessions.length, data: sessions });
});

exports.deleteSession = catchAsync(async (req, res) => {
  await ChatMessage.deleteMany({ sessionId: req.params.sessionId });
  res.json({ success: true, message: "Session deleted" });
});

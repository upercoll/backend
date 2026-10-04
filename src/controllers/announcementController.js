const { Announcement, EmailBroadcast } = require("../models/Announcement");
const Customer = require("../models/Customer");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const logger = require("../utils/logger");
const { sendBroadcastEmail } = require("../config/email");

const THEMES = ["blue", "pink", "green", "yellow", "red", "ink", "violet"];

// Resend rate-limits; we send in small batches with a gap so a 5k-recipient
// broadcast doesn't trip a 429 halfway through.
const BATCH_SIZE = 25;
const BATCH_DELAY_MS = 900;
// Hard ceiling per broadcast — keeps one request from queueing an unbounded job.
const MAX_RECIPIENTS = 5000;

function nowInWindow(doc) {
  if (!doc.published) return false;
  const now = new Date();
  if (doc.startsAt && now < new Date(doc.startsAt)) return false;
  if (doc.endsAt && now > new Date(doc.endsAt)) return false;
  return true;
}

function audienceFilter(audience) {
  switch (audience) {
    case "verified":
      return { emailVerified: true };
    case "buyers":
      return { totalSpent: { $gt: 0 } };
    case "non_buyers":
      return { $or: [{ totalSpent: { $in: [0, null] } }, { totalSpent: { $exists: false } }] };
    case "all":
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Public (storefront)
// ---------------------------------------------------------------------------

/** GET /api/announcements — everything the storefront popup needs. */
exports.listLive = catchAsync(async (req, res) => {
  const docs = await Announcement.find({ published: true }).sort({ priority: -1, createdAt: -1 }).lean();
  const live = docs.filter(nowInWindow);

  res.json({
    success: true,
    data: {
      announcements: live.map((a) => ({
        id: String(a._id),
        title: a.title,
        body: a.body,
        imageUrl: a.imageUrl || null,
        theme: a.theme,
        badge: a.badge || null,
        ctaLabel: a.ctaLabel || null,
        ctaUrl: a.ctaUrl || null,
        showAsModal: !!a.showAsModal,
        dismissible: a.dismissible !== false,
        promoCode: a.promoCode || null,
        publishedAt: a.createdAt,
        endsAt: a.endsAt || null,
      })),
    },
  });
});

/** POST /api/announcements/:id/view — fire-and-forget impression counter. */
exports.trackView = catchAsync(async (req, res) => {
  await Announcement.updateOne({ _id: req.params.id }, { $inc: { views: 1 } });
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Owner: CRUD
// ---------------------------------------------------------------------------

exports.listAll = catchAsync(async (req, res) => {
  const filter = {};
  if (req.query.status === "published") filter.published = true;
  if (req.query.status === "drafts") filter.published = false;

  const docs = await Announcement.find(filter).sort({ priority: -1, createdAt: -1 }).lean();

  res.json({
    success: true,
    data: {
      announcements: docs.map((a) => ({
        ...a,
        id: String(a._id),
        isLive: nowInWindow(a),
      })),
    },
  });
});

exports.create = catchAsync(async (req, res, next) => {
  const body = req.body || {};
  if (!String(body.title || "").trim()) return next(new AppError("Title is required", 400));
  if (!String(body.body || "").trim()) return next(new AppError("Message is required", 400));
  if (body.theme && !THEMES.includes(body.theme)) return next(new AppError("Unknown theme", 400));

  const doc = await Announcement.create({
    title: String(body.title).trim(),
    body: String(body.body).trim(),
    imageUrl: body.imageUrl || undefined,
    theme: body.theme || "blue",
    badge: body.badge || undefined,
    ctaLabel: body.ctaLabel || undefined,
    ctaUrl: body.ctaUrl || undefined,
    showAsModal: body.showAsModal !== false,
    dismissible: body.dismissible !== false,
    priority: Number.isFinite(Number(body.priority)) ? Number(body.priority) : 0,
    published: !!body.published,
    startsAt: body.startsAt || null,
    endsAt: body.endsAt || null,
    promoCode: body.promoCode || undefined,
    createdBy: req.panelUser?.id,
    createdByEmail: req.panelUser?.email,
  });

  res.status(201).json({ success: true, data: { announcement: { ...doc.toObject(), isLive: nowInWindow(doc) } } });
});

exports.update = catchAsync(async (req, res, next) => {
  const doc = await Announcement.findById(req.params.id);
  if (!doc) return next(new AppError("Announcement not found", 404));

  const body = req.body || {};
  if (body.theme && !THEMES.includes(body.theme)) return next(new AppError("Unknown theme", 400));

  const fields = [
    "title", "body", "imageUrl", "theme", "badge", "ctaLabel", "ctaUrl",
    "showAsModal", "dismissible", "published", "startsAt", "endsAt", "promoCode",
  ];
  fields.forEach((f) => {
    if (body[f] !== undefined) doc[f] = body[f] === "" ? undefined : body[f];
  });
  if (body.priority !== undefined) {
    const p = Number(body.priority);
    doc.priority = Number.isFinite(p) ? Math.max(-100, Math.min(100, p)) : 0;
  }
  if (body.title !== undefined && !String(doc.title || "").trim()) {
    return next(new AppError("Title cannot be empty", 400));
  }
  if (body.body !== undefined && !String(doc.body || "").trim()) {
    return next(new AppError("Message cannot be empty", 400));
  }

  await doc.save();
  res.json({ success: true, data: { announcement: { ...doc.toObject(), isLive: nowInWindow(doc) } } });
});

exports.remove = catchAsync(async (req, res, next) => {
  const doc = await Announcement.findByIdAndDelete(req.params.id);
  if (!doc) return next(new AppError("Announcement not found", 404));
  res.json({ success: true, message: "Announcement deleted" });
});

// ---------------------------------------------------------------------------
// Owner: bulk email broadcast
// ---------------------------------------------------------------------------

/** GET /api/announcements/broadcasts — send history. */
exports.listBroadcasts = catchAsync(async (req, res) => {
  const docs = await EmailBroadcast.find().sort({ createdAt: -1 }).limit(50).lean();
  res.json({
    success: true,
    data: {
      broadcasts: docs.map((b) => ({ ...b, id: String(b._id) })),
    },
  });
});

/** GET /api/announcements/audience-count?audience=buyers — live recipient count. */
exports.audienceCount = catchAsync(async (req, res) => {
  const audience = String(req.query.audience || "all");
  const count = await Customer.countDocuments(audienceFilter(audience));
  res.json({ success: true, data: { audience, count } });
});

/**
 * POST /api/announcements/broadcasts
 *
 * Queues an email to every registered customer. Returns immediately with the
 * broadcast record; progress is written back to that record as batches go out
 * so the admin can watch it, and it can be cancelled mid-flight.
 */
exports.sendBroadcast = catchAsync(async (req, res, next) => {
  const { subject, body, audience = "all", promoCode, ctaLabel, ctaUrl } = req.body || {};
  if (!String(subject || "").trim()) return next(new AppError("Subject is required", 400));
  if (!String(body || "").trim()) return next(new AppError("Message is required", 400));
  if (!["all", "verified", "buyers", "non_buyers"].includes(audience)) {
    return next(new AppError("Unknown audience", 400));
  }

  const recipients = await Customer.find(audienceFilter(audience))
    .select("email displayName")
    .limit(MAX_RECIPIENTS)
    .lean();

  const unique = [];
  const seen = new Set();
  for (const r of recipients) {
    const email = String(r.email || "").trim().toLowerCase();
    if (!email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    unique.push({ email, name: r.displayName || "" });
  }

  if (unique.length === 0) {
    return next(new AppError("No customers match that audience", 400));
  }

  const broadcast = await EmailBroadcast.create({
    subject: String(subject).trim(),
    body: String(body).trim(),
    audience,
    promoCode: promoCode || undefined,
    status: "sending",
    recipients: unique.length,
    sentBy: req.panelUser?.id,
    sentByEmail: req.panelUser?.email,
  });

  // Fire-and-forget batches. Each batch awaits the previous one's timer so the
  // sends stay spaced out without holding the HTTP request open.
  let cursor = 0;
  const runBatch = async () => {
    const slice = unique.slice(cursor, cursor + BATCH_SIZE);
    if (slice.length === 0) {
      await EmailBroadcast.updateOne(
        { _id: broadcast._id, cancelled: { $ne: true } },
        { $set: { status: "sent" } }
      );
      return;
    }
    cursor += slice.length;

    let ok = 0;
    let failed = 0;
    let lastError = "";
    await Promise.all(
      slice.map(async (r) => {
        try {
          await sendBroadcastEmail({
            to: r.email,
            subject: broadcast.subject,
            body: r.name ? `${r.name},\n\n${broadcast.body}` : broadcast.body,
            promoCode: broadcast.promoCode,
            ctaLabel,
            ctaUrl,
          });
          ok += 1;
        } catch (err) {
          failed += 1;
          lastError = String(err.message || err).slice(0, 300);
          logger.warn(`Broadcast ${broadcast._id} → ${r.email} failed: ${lastError}`);
        }
      })
    );

    const update = { $inc: { sent: ok, failed }, $set: { lastError } };
    await EmailBroadcast.updateOne({ _id: broadcast._id }, update);

    const still = await EmailBroadcast.findOne({ _id: broadcast._id }).select("cancelled").lean();
    if (still?.cancelled) return;

    setTimeout(runBatch, BATCH_DELAY_MS);
  };

  // Kick off after the response so the owner gets the record immediately.
  setTimeout(runBatch, 50);

  res.status(201).json({
    success: true,
    data: {
      broadcast: { ...broadcast.toObject(), id: String(broadcast._id) },
      queued: unique.length,
    },
  });
});

/** POST /api/announcements/broadcasts/:id/cancel — stop an in-flight send. */
exports.cancelBroadcast = catchAsync(async (req, res, next) => {
  const doc = await EmailBroadcast.findById(req.params.id);
  if (!doc) return next(new AppError("Broadcast not found", 404));
  if (!["queued", "sending"].includes(doc.status)) {
    return next(new AppError("This broadcast has already finished", 400));
  }
  doc.cancelled = true;
  doc.status = "cancelled";
  await doc.save();
  res.json({ success: true, data: { broadcast: doc } });
});

module.exports.announcement = exports;
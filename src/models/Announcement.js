const mongoose = require("mongoose");

/**
 * Site-wide announcements.
 *
 * These are owner-authored "posts" that double as storefront popups. The admin
 * UI treats them like forum threads (one document per announcement) and the
 * storefront fetches the live set from GET /api/announcements.
 */
const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 140 },
    body: { type: String, required: true, trim: true, maxlength: 4000 },

    // Optional art for the split-layout popup. Left side of the modal.
    imageUrl: { type: String, trim: true },

    // Visual identity of the popup. Flat colour pairs only — no gradients in
    // the token sense, just two solid stops for the art panel.
    theme: {
      type: String,
      enum: ["blue", "pink", "green", "yellow", "red", "ink", "violet"],
      default: "blue",
    },

    // Small label above the title, e.g. "SALE", "NEW", "MAINTENANCE".
    badge: { type: String, trim: true, maxlength: 24 },

    // Call-to-action button under the body.
    ctaLabel: { type: String, trim: true, maxlength: 40 },
    ctaUrl: { type: String, trim: true, maxlength: 500 },

    // Popup behaviour
    showAsModal: { type: Boolean, default: true },
    dismissible: { type: Boolean, default: true },

    // Higher priority sorts first and wins when several are live at once.
    priority: { type: Number, default: 0, min: -100, max: 100 },

    published: { type: Boolean, default: false },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },

    // Optional promo code to surface in the popup (and optionally email).
    promoCode: { type: String, trim: true, maxlength: 30 },

    views: { type: Number, default: 0 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    createdByEmail: { type: String, trim: true },
  },
  { timestamps: true }
);

announcementSchema.index({ published: 1, priority: -1, createdAt: -1 });

// Live = published, inside its window, and (when a popup) not deleted.
announcementSchema.virtual("isLive").get(function () {
  if (!this.published) return false;
  const now = new Date();
  if (this.startsAt && now < this.startsAt) return false;
  if (this.endsAt && now > this.endsAt) return false;
  return true;
});

/**
 * Bulk email broadcasts. Every send is recorded so the owner can audit exactly
 * what went out, to how many people, and how many bounced.
 */
const broadcastSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 8000 },

    audience: {
      type: String,
      enum: ["all", "verified", "buyers", "non_buyers"],
      default: "all",
    },

    // Optional promo code shown in the email body.
    promoCode: { type: String, trim: true, maxlength: 30 },

    status: {
      type: String,
      enum: ["queued", "sending", "sent", "failed", "cancelled"],
      default: "queued",
    },

    recipients: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    cancelled: { type: Boolean, default: false },

    lastError: { type: String, trim: true },

    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    sentByEmail: { type: String, trim: true },
  },
  { timestamps: true }
);

broadcastSchema.index({ createdAt: -1 });

module.exports = {
  Announcement: mongoose.model("Announcement", announcementSchema),
  EmailBroadcast: mongoose.model("EmailBroadcast", broadcastSchema),
};
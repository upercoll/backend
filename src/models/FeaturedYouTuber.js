const mongoose = require("mongoose");

const featuredYouTuberSchema = new mongoose.Schema({
  username: { type: String, required: true, trim: true, unique: true },
  channelId: { type: String, default: "" },
  name: { type: String, default: "" },
  subscribers: { type: Number, default: 0 },
  avatarUrl: { type: String, default: "" },
  channelUrl: { type: String, default: "" },
  active: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model("FeaturedYouTuber", featuredYouTuberSchema);

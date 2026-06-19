const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    description: { type: String, trim: true },
    game: { type: String, required: true, trim: true },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    subcategory: { type: String, trim: true },

    price: { type: Number, required: true, min: 0 },
    originalPrice: { type: Number, min: 0 },

    gradient: {
      from: { type: String, default: "#7c3aed" },
      to: { type: String, default: "#4c1d95" },
    },
    imageUrl: { type: String },

    stock: { type: Number, default: -1 },
    onHand: { type: Number, default: -1 },
    outOfStock: { type: Boolean, default: false },

    featured: { type: Boolean, default: false },
    bestSeller: { type: Boolean, default: false },

    tags: [{ type: String, trim: true, lowercase: true }],

    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },

    salesCount: { type: Number, default: 0 },
    viewCount: { type: Number, default: 0 },

    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

productSchema.index({ game: 1, active: 1 });
productSchema.index({ category: 1, active: 1 });
productSchema.index({ featured: 1, active: 1 });
productSchema.index({ bestSeller: 1, active: 1 });
productSchema.index({ name: "text", description: "text", tags: "text" });

module.exports = mongoose.model("Product", productSchema);

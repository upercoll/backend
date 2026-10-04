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

    // Purchase notice shown on the product page (e.g. Fisch: "only usable if
    // you own the boat"). When required=true the buyer must tick the
    // acknowledgment box before Add to Cart / Buy Now unlock.
    notice: {
      text: { type: String, trim: true, default: "" },
      required: { type: Boolean, default: false },
    },

    // Display-only option groups (e.g. BedWars kit skin styles). Purely
    // informational: no price or delivery impact, never sent to checkout.
    variations: [
      {
        name: { type: String, trim: true },
        options: [{ type: String, trim: true }],
        _id: false,
      },
    ],

    gradient: {
      from: { type: String, default: "#7c3aed" },
      to: { type: String, default: "#4c1d95" },
    },
    imageUrl: { type: String },
    images: [{ type: String, trim: true }],
    features: [{ type: String, trim: true }],

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

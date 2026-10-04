const Product = require("../models/Product");
const StockRequest = require("../models/StockRequest");
const StockSale = require("../models/StockSale");

const finiteQuantity = (value) => Number.isInteger(value) && value > 0;

async function addStock(productId, quantity) {
  if (!finiteQuantity(quantity)) throw new Error("Stock quantity must be a positive whole number");

  return Product.findByIdAndUpdate(
    productId,
    [
      {
        $set: {
          // -1 means “unlimited” for storefront products. Stocking a real batch must
          // start at zero, not add to the sentinel (-1 + 2 previously became 1).
          stock: { $add: [{ $cond: [{ $lt: ["$stock", 0] }, 0, "$stock"] }, quantity] },
          onHand: { $add: [{ $cond: [{ $lt: ["$onHand", 0] }, 0, "$onHand"] }, quantity] },
          outOfStock: false,
        },
      },
    ],
    { new: true }
  );
}

async function removeStock(productId, quantity) {
  if (!finiteQuantity(quantity)) throw new Error("Sale quantity must be a positive whole number");

  const product = await Product.findOneAndUpdate(
    {
      _id: productId,
      $and: [
        { $or: [{ stock: -1 }, { stock: { $gte: quantity } }] },
        { $or: [{ onHand: -1 }, { onHand: { $gte: quantity } }] },
      ],
    },
    [
      {
        $set: {
          stock: { $cond: [{ $lt: ["$stock", 0] }, -1, { $subtract: ["$stock", quantity] }] },
          onHand: { $cond: [{ $lt: ["$onHand", 0] }, -1, { $subtract: ["$onHand", quantity] }] },
          salesCount: { $add: [{ $ifNull: ["$salesCount", 0] }, quantity] },
        },
      },
    ],
    { new: true }
  );

  if (product && product.stock === 0) {
    await Product.updateOne({ _id: product._id }, { $set: { outOfStock: true } });
  }
  return product;
}

async function removeStockForDeletedRequest(productId, quantity) {
  if (!finiteQuantity(quantity)) throw new Error("Stock quantity must be a positive whole number");

  const product = await Product.findOneAndUpdate(
    {
      _id: productId,
      $and: [
        { $or: [{ stock: -1 }, { stock: { $gte: quantity } }] },
        { $or: [{ onHand: -1 }, { onHand: { $gte: quantity } }] },
      ],
    },
    [
      {
        $set: {
          stock: { $cond: [{ $lt: ["$stock", 0] }, -1, { $subtract: ["$stock", quantity] }] },
          onHand: { $cond: [{ $lt: ["$onHand", 0] }, -1, { $subtract: ["$onHand", quantity] }] },
        },
      },
    ],
    { new: true }
  );
  if (product && product.stock === 0) {
    await Product.updateOne({ _id: product._id }, { $set: { outOfStock: true } });
  }
  return product;
}

async function allocateStockedBatches(order) {
  const sales = [];

  for (const item of order.items || []) {
    let remaining = item.quantity;
    const allocations = [];
    const requests = await StockRequest.find({
      status: "stocked",
      items: { $elemMatch: { product: item.product, remainingQuantity: { $gt: 0 } } },
    }).sort({ stockedAt: 1, createdAt: 1 });

    for (const request of requests) {
      if (remaining <= 0) break;
      const requestItem = request.items.find(
        (candidate) => String(candidate.product) === String(item.product) && (candidate.remainingQuantity || 0) > 0
      );
      if (!requestItem) continue;

      // Bounded retry: another sale may have taken the batch between our read
      // and the conditional update. Giving up silently (the old `continue`)
      // sold stock without attributing it, so the stocker lost that commission.
      let allocatedQuantity = 0;
      let updated = null;
      for (let attempt = 0; attempt < 5 && !updated; attempt++) {
        const fresh = await StockRequest.findOne({ _id: request._id }).select("items").lean();
        const freshItem = (fresh?.items || []).find((i) => String(i.product) === String(item.product));
        const available = Number(freshItem?.remainingQuantity) || 0;
        allocatedQuantity = Math.min(remaining, available);
        if (allocatedQuantity <= 0) break;

        updated = await StockRequest.findOneAndUpdate(
          {
            _id: request._id,
            items: {
              $elemMatch: {
                product: item.product,
                remainingQuantity: { $gte: allocatedQuantity },
              },
            },
          },
          {
            $inc: {
              "items.$.remainingQuantity": -allocatedQuantity,
              "items.$.soldQuantity": allocatedQuantity,
            },
          },
          { new: true }
        );
      }
      if (!updated || allocatedQuantity <= 0) continue;

      allocations.push({
        request: request._id,
        stocker: request.stocker,
        quantity: allocatedQuantity,
        // Agreed store price ONLY. Falling back to `salePrice` (a number the
        // stocker typed) would let them choose their own revenue basis.
        unitRevenue: Number(requestItem.storePrice ?? 0),
        // Freeze the rate selected when this batch was stocked. A later profile
        // edit must never change what a completed sale pays.
        commissionRate: Number(request.commissionRate || 0),
      });
      remaining -= allocatedQuantity;
    }

    if (allocations.length) {
      sales.push({
        order: order._id,
        orderNumber: order.orderNumber,
        product: item.product,
        productName: item.productSnapshot?.name || "Item",
        quantity: item.quantity - remaining,
        customer: {
          robloxUsername: order.customer?.robloxUsername || "",
          email: order.customer?.email || "",
        },
        allocations,
      });
    }
  }

  if (sales.length) await StockSale.insertMany(sales);
  return sales;
}

async function rollbackStockedBatchAllocations(orderId) {
  // Atomically claim the sales BEFORE restoring anything. Two concurrent callers
  // (refund + a failed payment-finalize) both used to read the same StockSale
  // docs and each added the quantity back — remainingQuantity then exceeded the
  // real quantity and units that never existed could be allocated to other
  // orders (oversell, plus commission on phantom stock).
  const sales = [];
  for (;;) {
    const pending = await StockSale.findOne({ order: orderId });
    if (!pending) break;
    const claimed = await StockSale.findOneAndDelete({ _id: pending._id });
    if (!claimed) continue; // someone else claimed this one — try the next
    sales.push(claimed);
    if (sales.length > 500) break; // safety valve; orders never have more sales
  }

  for (const sale of sales) {
    for (const allocation of sale.allocations || []) {
      const restored = Math.max(0, Number(allocation.quantity) || 0);
      if (!restored) continue;
      await StockRequest.updateOne(
        { _id: allocation.request },
        {
          // The sale doc is deleted atomically above, so a replayed rollback
          // finds nothing to restore — remainingQuantity cannot be inflated.
          $inc: {
            "items.$[item].remainingQuantity": restored,
            "items.$[item].soldQuantity": -restored,
          },
        },
        { arrayFilters: [{ "item.product": sale.product }] }
      );
    }
  }
  return sales.length;
}

async function markOrderDelivered(orderNumber, claimRoomId) {
  const sales = await StockSale.find({ orderNumber, deliveredAt: { $exists: false } });
  if (!sales.length) return [];

  const deliveredAt = new Date();
  for (const sale of sales) {
    const updated = await StockSale.findOneAndUpdate(
      { _id: sale._id, deliveredAt: { $exists: false } },
      { $set: { deliveredAt, claimRoomId } },
      { new: true }
    );
    if (!updated) continue;

  }
  return sales;
}

module.exports = {
  addStock,
  removeStock,
  removeStockForDeletedRequest,
  allocateStockedBatches,
  rollbackStockedBatchAllocations,
  markOrderDelivered,
};

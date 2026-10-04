/**
 * Serialises work per room id, in-process.
 *
 * The auto-delivery endpoints are PUBLIC (the Roblox bot has no login) and both
 * do a read-modify-write on the same ClaimSession document:
 *
 *   claim  -> reads autoDelivery.reservations, computes how much is still free,
 *             then writes the new reservation list
 *   deliver -> reads item.delivered, computes how much is still owed, then
 *             writes the new delivered counts
 *
 * There is no atomic guard on either, so two bot accounts polling the same
 * order at the same moment could both reserve (or both credit) the same
 * quantity. Chaining the promises per room makes each pair run one after the
 * other instead of interleaved.
 *
 * Single-process only — this protects against concurrent requests on one
 * instance, which is what Render runs.
 */
const chains = new Map();

function withRoomLock(roomId, fn) {
  const key = String(roomId);
  const previous = chains.get(key) || Promise.resolve();

  // Run whether or not the previous holder succeeded.
  const run = previous.then(fn, fn);
  // Register a handler on `run` so a rejection can never surface as an
  // unhandled promise rejection when the caller ignores the return value.
  const tail = run.then(
    () => {},
    () => {}
  );
  chains.set(key, tail);
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });

  return run;
}

module.exports = { withRoomLock };

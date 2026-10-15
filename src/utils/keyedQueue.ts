const tails = new Map<string, Promise<void>>();

/**
 * Runs `task` only after every previously queued task for the same `key`
 * has settled, so tasks sharing a key never overlap. Used to process one
 * customer's WhatsApp messages strictly in arrival order — two messages
 * sent seconds apart would otherwise run the state machine concurrently
 * against the same session/order state and race each other.
 *
 * In-process only: correct for the current single-instance deployment
 * (the stock-confirmation sweeps in index.ts already assume one instance).
 * Running several API instances would need a shared lock or queue instead
 * (e.g. Redis/BullMQ keyed by phone).
 *
 * A failing task never blocks the ones queued after it; its rejection is
 * still returned to this caller.
 */
export function runSerialized(key: string, task: () => Promise<void>): Promise<void> {
  const previous = tails.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  tails.set(key, current);

  const cleanup = () => {
    if (tails.get(key) === current) tails.delete(key);
  };
  current.then(cleanup, cleanup);

  return current;
}

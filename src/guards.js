// Last line of defence: a stray rejection or exception in one request path must not kill the whole service
// (every user would lose it). We log loudly, count it (visible in /api/health) and keep serving.
export function installProcessGuards(proc = process, log = console) {
  const stats = { unhandledRejections: 0, uncaughtExceptions: 0, last: null };
  proc.on('unhandledRejection', (reason) => {
    stats.unhandledRejections += 1; stats.last = String(reason?.message ?? reason).slice(0, 200);
    log.error('[guard] unhandled rejection (service keeps running):', reason?.stack ?? reason);
  });
  proc.on('uncaughtException', (err) => {
    stats.uncaughtExceptions += 1; stats.last = String(err?.message ?? err).slice(0, 200);
    log.error('[guard] uncaught exception (service keeps running):', err?.stack ?? err);
  });
  return stats;
}

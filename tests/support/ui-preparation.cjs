// A manually driven frame scheduler lets tests inspect a partially-created HUD
// and simulate scene teardown without timing-dependent sleeps.
function preparationDriver() {
  const pending = [];
  const prepare = steps => new Promise((resolve, reject) => pending.push({ steps, resolve, reject }));
  const advance = (limit = 1) => {
    const task = pending[0];
    if (!task) return 0;
    let count = 0;
    try {
      while (count < limit) {
        const next = task.steps.next(); count++;
        if (next.done) { pending.shift(); task.resolve(); break; }
      }
    } catch (error) { pending.shift(); task.reject(error); }
    return count;
  };
  const flush = async () => {
    await Promise.resolve();
    while (pending.length) { advance(16); await Promise.resolve(); }
    await Promise.resolve();
  };
  return { prepare, advance, flush, get pending() { return pending.length; } };
}
module.exports = { preparationDriver };

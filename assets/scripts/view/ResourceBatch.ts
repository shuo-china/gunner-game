import { RESOURCE_LOADING_POLICY } from './ResourceLoadingPolicy';

/** Keep a first-use panel's requests bounded, retry only failed resources, and
 * settle every worker before allowing the panel to retry or create its nodes. */
export async function loadResourceBatch(tasks: (() => Promise<unknown>)[],
  wait: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))): Promise<void> {
  let next = 0;
  const failures: unknown[] = [];
  const { maxConcurrency, retryDelaysMs } = RESOURCE_LOADING_POLICY.foreground;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const task = tasks[next++];
      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
        try { await task(); break; }
        catch (error) {
          if (attempt === retryDelaysMs.length) failures.push(error);
          else await wait(retryDelaysMs[attempt]);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, tasks.length) }, () => worker()));
  if (failures.length) throw new Error(`Resource loading failed (${failures.length}): ${String(failures[0])}`);
}

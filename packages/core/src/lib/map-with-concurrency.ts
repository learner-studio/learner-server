/**
 * Bounded-parallelism map: N workers pull from one shared cursor, each taking
 * the next item the moment it frees.
 *
 * A ROLLING POOL, not fixed batches, and the difference is the whole point.
 * `Promise.all` over slices pays the SLOWEST member of each slice, so the gain
 * shrinks as the work gets uneven. Measured on curriculum run 4b719d66, whose
 * seven lane calls took 234, 380, 415, 525, 569, 616 and 818 seconds: at a
 * width of three, slices take 33.4 minutes and this takes 23.1, because a
 * 234-second task sharing a slice with an 818-second one leaves its slot idle
 * for nearly ten minutes.
 *
 * RESULTS COME BACK IN INPUT ORDER, never completion order. Callers fold over
 * the results, and "whichever finished first" is the kind of ordering that
 * makes a run reproducible on a fast day and not on a slow one.
 *
 * A task that throws rejects the whole call AND stops new work being handed
 * out. Slots already in flight are not cancelled — there is nothing to cancel a
 * model call or an HTTP fetch with — so a failure costs at most `limit - 1`
 * extra tasks rather than the rest of the queue. Before 2026-09-11 the other
 * workers kept draining the queue after a sibling had already failed, which for
 * a crawl or a lane call meant minutes of work spent on a result nobody would
 * read.
 *
 * IN-PROCESS ONLY. The queue lives in a local variable, so a restart loses the
 * position, the results, and any knowledge that work was in flight. That is
 * correct for callers inside a durable step that replays as a unit. When the
 * unit of work is worth resuming on its own, the mechanism is the pg-boss queue
 * group in `lib/workflow/rolling-queue.ts` instead — which costs job-key
 * adoption under a lock and lease arithmetic, and buys durability.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	let failed = false;
	const workerCount = Math.max(1, Math.min(Math.floor(limit), items.length));
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			for (let i = cursor++; i < items.length; i = cursor++) {
				// Checked AFTER taking the index, not before, so a worker that
				// lost the race still stops rather than starting one more task
				// into a call whose result is already going to be thrown away.
				if (failed) return;
				try {
					results[i] = await fn(items[i]!, i);
				} catch (error) {
					failed = true;
					throw error;
				}
			}
		}),
	);
	return results;
}

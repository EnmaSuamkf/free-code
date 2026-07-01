/**
 * In-memory event queue with long-poll support for the webhook-receiver.
 *
 * `enqueue` hands an event directly to a pending `wait()` caller if one exists,
 * otherwise buffers it (bounded). `wait()` resolves on the next event, on
 * timeout, or when its AbortSignal fires (e.g. the agent turn is aborted).
 */

export interface WebhookEvent {
	name: string;
	receivedAt: string;
	headers: Record<string, string>;
	body: unknown;
}

interface Waiter {
	fulfill: (event: WebhookEvent | null) => void;
}

export class EventRegistry {
	private queue: WebhookEvent[] = [];
	private waiters: Waiter[] = [];
	private readonly maxQueue = 1000;

	enqueue(event: WebhookEvent): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter.fulfill(event);
			return;
		}
		this.queue.push(event);
		if (this.queue.length > this.maxQueue) this.queue.shift();
	}

	peek(): WebhookEvent[] {
		return [...this.queue];
	}

	drain(): WebhookEvent[] {
		const out = this.queue;
		this.queue = [];
		return out;
	}

	size(): number {
		return this.queue.length;
	}

	wait(timeoutMs: number, signal?: AbortSignal): Promise<WebhookEvent | null> {
		const existing = this.queue.shift();
		if (existing) return Promise.resolve(existing);

		return new Promise((resolve) => {
			let settled = false;
			const waiter: Waiter = {
				fulfill: (event) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					this.waiters = this.waiters.filter((w) => w !== waiter);
					resolve(event);
				},
			};
			const onAbort = () => waiter.fulfill(null);
			const timer = setTimeout(() => waiter.fulfill(null), timeoutMs);
			this.waiters.push(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	clear(): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const w of waiters) w.fulfill(null);
		this.queue = [];
	}
}

import { randomBytes } from 'crypto';
import { connect } from 'amqplib';
import { videoProcessingTopology } from '../messaging/messaging.constants';

/**
 * Points RABBITMQ_NAMESPACE at a throwaway namespace so the long-running
 * `video-worker` container never consumes test messages (TD-10 Revision).
 * Call before compiling the module (config factories read process.env).
 */
export function useIsolatedQueueNamespaceForTests(
  label: string,
  retryDelayMs = 200,
): string {
  const namespace = `test.${label}.${randomBytes(4).toString('hex')}`;
  process.env.RABBITMQ_NAMESPACE = namespace;
  process.env.VIDEO_PROCESSING_RETRY_DELAY_MS = String(retryDelayMs);
  return namespace;
}

/** Deletes the exchange and queues of a test namespace. */
export async function deleteQueueNamespace(namespace: string): Promise<void> {
  const names = videoProcessingTopology(namespace);
  const connection = await connect(process.env.RABBITMQ_URL ?? '');
  try {
    const channel = await connection.createChannel();
    for (const queue of [names.queue, names.retryQueue, names.deadQueue]) {
      await channel.deleteQueue(queue);
    }
    await channel.deleteExchange(names.exchange);
    await channel.close();
  } finally {
    await connection.close();
  }
}

/** Reads (and acks) every message currently in a queue. */
export async function drainQueue(
  queue: string,
): Promise<{ body: unknown; headers: Record<string, unknown> }[]> {
  const connection = await connect(process.env.RABBITMQ_URL ?? '');
  const out: { body: unknown; headers: Record<string, unknown> }[] = [];
  try {
    const channel = await connection.createChannel();
    for (;;) {
      const msg = await channel.get(queue, { noAck: true });
      if (!msg) break;
      out.push({
        body: JSON.parse(msg.content.toString()),
        headers: (msg.properties.headers ?? {}) as Record<string, unknown>,
      });
    }
    await channel.close();
  } finally {
    await connection.close();
  }
  return out;
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false>,
  { timeoutMs = 15_000, intervalMs = 100 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

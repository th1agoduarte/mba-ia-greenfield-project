export const AMQP_CONNECTION = Symbol('AMQP_CONNECTION');

export const VIDEO_UPLOADED_ROUTING_KEY = 'video.uploaded';

/** Attempt counter carried on every `video.uploaded` delivery (TD-12). */
export const ATTEMPT_HEADER = 'x-attempt';

/** Publisher confirm timeout, so an unreachable broker fails the request. */
export const PUBLISH_TIMEOUT_MS = 10_000;

export interface VideoProcessingTopology {
  exchange: string;
  queue: string;
  retryQueue: string;
  deadQueue: string;
}

/** Exchange/queue names derived from RABBITMQ_NAMESPACE (Events/Messages). */
export function videoProcessingTopology(
  namespace: string,
): VideoProcessingTopology {
  return {
    exchange: namespace,
    queue: `${namespace}.processing`,
    retryQueue: `${namespace}.processing.retry`,
    deadQueue: `${namespace}.processing.dead`,
  };
}

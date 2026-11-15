export interface VideoUploadedMessage {
  video_id: string;
}

export interface DeliveryContext {
  attempt: number;
  isLastAttempt: boolean;
}

/**
 * - `ok`: processed (or nothing to do) — ack.
 * - `retry`: transient failure — republish to the retry queue (or park it
 *   when the attempts are exhausted).
 * - `fail`: terminal failure — park it in the dead queue.
 */
export type ProcessingOutcome = 'ok' | 'retry' | 'fail';

export type VideoUploadedHandler = (
  message: VideoUploadedMessage,
  context: DeliveryContext,
) => Promise<ProcessingOutcome>;

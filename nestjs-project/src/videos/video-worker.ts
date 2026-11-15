import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { VideoProcessingConsumer } from '../messaging/video-processing.consumer';
import { VideoProcessingService } from './video-processing.service';

/** Wires the queue consumer to the processing service when the worker boots. */
@Injectable()
export class VideoWorker implements OnApplicationBootstrap {
  constructor(
    private readonly consumer: VideoProcessingConsumer,
    private readonly processing: VideoProcessingService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.start((message, context) =>
      this.processing.handle(message, context),
    );
  }
}

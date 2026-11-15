import { Test } from '@nestjs/testing';
import { VideoProcessingService } from './videos/video-processing.service';
import { VideoWorker } from './videos/video-worker';
import { WorkerModule } from './worker.module';

describe('WorkerModule (integration)', () => {
  it('compiles with the processing service and the queue worker', async () => {
    // Connects to Postgres (rootImports), but compile() runs no lifecycle hook,
    // so the queue consumer is not started.
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessingService)).toBeDefined();
    expect(module.get(VideoWorker)).toBeDefined();
    await module.close();
  });
});

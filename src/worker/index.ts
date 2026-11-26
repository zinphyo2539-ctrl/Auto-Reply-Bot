import type {
  Env,
  ExecutionContext,
  MessageBatch,
  OutboxQueuePayload,
  ScheduledController,
} from './types/bindings';
import { createApp } from './app/createApp';
import { outboxConsumer } from './queues/outboxConsumer';
import { scheduledDispatcher } from './scheduled/dispatcher';

const app = createApp();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async queue(
    batch: MessageBatch<OutboxQueuePayload>,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    await outboxConsumer.processBatch(env, batch);
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    await scheduledDispatcher.dispatch(env, controller);
  },
};

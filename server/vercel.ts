import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';

// Built once per serverless instance and reused across invocations.
let ready: Promise<FastifyInstance> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  ready ??= buildApp().then(async ({ app }) => {
    await app.ready();
    return app;
  });
  const app = await ready;
  app.server.emit('request', req, res);
}

import { buildApp } from './app';

const port = Number(process.env.PORT ?? 8787);
const { app, ctx } = await buildApp({ logger: true });

// Safety net for anything the immediate dispatch could not deliver (retries with backoff).
setInterval(() => void ctx.dispatcher.processDue(), 15_000).unref();

await app.listen({ port, host: '0.0.0.0' });
app.log.info(`Preshift API on :${port}, docs at /docs, payroll via ${ctx.providerFor('demo').name}`);

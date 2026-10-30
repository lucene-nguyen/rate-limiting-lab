import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { hostname } from 'node:os';
import { AppModule } from './app.module.js';

const PORT = Number(process.env.PORT ?? 3000);
// Number of reverse-proxy hops in front of the app (Nginx = 1).
// Without this, req.ip is the proxy's IP and every client shares one bucket.
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS ?? 0);

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  if (TRUST_PROXY_HOPS > 0) app.set('trust proxy', TRUST_PROXY_HOPS);

  // Tag every response with the instance that served it, so load tests
  // can show traffic is spread across replicas.
  const instance = hostname();
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('X-Instance', instance);
    next();
  });

  await app.listen(PORT);
  console.log(`[${instance}] listening on ${PORT}, trust proxy hops=${TRUST_PROXY_HOPS}`);
}
await bootstrap();

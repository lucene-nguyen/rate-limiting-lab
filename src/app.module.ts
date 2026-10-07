import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { CacheModule } from '@nestjs/cache-manager';
import { createKeyv } from '@keyv/redis';
import { RateLimiter } from './middlewares/rate-limiter.middleware.js';
import { RedisProvider } from './redis/redis.provider.js';
@Module({
  controllers: [AppController],
  providers: [AppService, RedisProvider],
})
export class AppModule implements NestModule {
  // global middle registered with app.use cannot access the DI container(only accept functional middle).
  // in this case we use a class middleware so I bind it with .forRoutes('*') at here.
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RateLimiter).forRoutes('*');
  }
}

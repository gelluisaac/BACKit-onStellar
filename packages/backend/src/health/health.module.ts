import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { HealthController } from './health.controller';
import { ShutdownService } from './shutdown.service';

@Module({
  imports: [
    HttpModule, // provides HttpService for Stellar RPC ping
  ],
  controllers: [HealthController],
  providers: [ShutdownService],
  exports: [ShutdownService],
  // DataSource is provided globally by TypeOrmModule.forRoot() in AppModule
  // so it can be injected directly — no extra registration needed here
})
export class HealthModule {}

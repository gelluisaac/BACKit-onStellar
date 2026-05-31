import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Call } from '../calls/entities/call.entity';
import { CallReport } from '../calls/entities/call-report.entity';
import { Users } from '../user/entities/users.entity';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Call, CallReport, Users]),
    AuditModule, // provides AuditInterceptor (registered as APP_INTERCEPTOR) and AuditService
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}

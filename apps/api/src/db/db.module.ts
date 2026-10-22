import { Global, Module } from '@nestjs/common';
import { DbService } from './db.service.js';
import { AuditService } from './audit.service.js';

@Global()
@Module({ providers: [DbService, AuditService], exports: [DbService, AuditService] })
export class DbModule {}

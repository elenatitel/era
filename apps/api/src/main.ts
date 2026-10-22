import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap.js';
import { config } from './config.js';

const app = await createApp();
await app.listen(config().PORT, '0.0.0.0');
new Logger('Bootstrap').log(`API listening on :${config().PORT}`);

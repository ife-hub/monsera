// scripts/send-test-alert.js
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { PaymentEventsProcessor } = require('../dist/events/payment-events.processor');

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const processor = app.get(PaymentEventsProcessor);

    await processor.process({
      data: {
        type: 'ops.alert',
        occurredAt: new Date().toISOString(),
        data: {
          severity: 'warning', // use 'critical' to test SMS too
          title: 'Test alert',
          message: 'If you can read this, the alert path works.',
        },
      },
    });
    console.log('alert handled, check your inbox');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('failed:', err);
  process.exit(1);
});
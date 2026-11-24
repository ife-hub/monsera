import { Redis } from 'ioredis';

export function createRedisConnection(): Redis {
  // Only needed if you get a certificate error. Paste the cluster's CA
  // certificate with its line breaks written as \n.
  const caCert = process.env.REDIS_CA_CERT?.replace(/\\n/g, '\n');

  return new Redis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: null, // required by BullMQ
    ...(caCert ? { tls: { ca: caCert } } : {}),
  });
}
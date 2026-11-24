import { DigestService, DIGEST_FLUSH_JOB } from '../src/digest/digest.service';
import { PaymentEventsProcessor } from '../src/events/payment-events.processor';

/** Just enough of ioredis for these tests. */
class FakeRedis {
  lists = new Map<string, string[]>();
  keys = new Map<string, string>();
  async rpush(k: string, ...v: string[]) { this.lists.set(k, [...(this.lists.get(k) ?? []), ...v]); }
  async lpush(k: string, ...v: string[]) { this.lists.set(k, [...v.slice().reverse(), ...(this.lists.get(k) ?? [])]); }
  multi() {
    const ops: Array<() => unknown> = [];
    const chain = {
      lrange: (k: string) => { ops.push(() => [...(this.lists.get(k) ?? [])]); return chain; },
      del: (k: string) => { ops.push(() => this.lists.delete(k)); return chain; },
      exec: async () => ops.map((op) => [null, op()]),
    };
    return chain;
  }
  async set(k: string, v: string, _px: string, _ms: number, _nx: string) {
    if (this.keys.has(k)) return null;
    this.keys.set(k, v);
    return 'OK';
  }
  async del(k: string) { this.keys.delete(k); }
}

const change = (id: number, to = 'Delayed') => ({ obligationId: id, meterToken: `MT-${id}`, discoAdminId: 1, from: 'Watch', to, remainingKobo: 150000 });

let redis: FakeRedis;
let mail: { sendToAlertRecipients: jest.Mock; send: jest.Mock };
let queue: { add: jest.Mock };
let sms: { send: jest.Mock };
let digest: DigestService;
let processor: PaymentEventsProcessor;

beforeEach(() => {
  redis = new FakeRedis();
  mail = { sendToAlertRecipients: jest.fn().mockResolvedValue(undefined), send: jest.fn() };
  queue = { add: jest.fn().mockResolvedValue({}) };
  sms = { send: jest.fn().mockResolvedValue(undefined) };
  digest = new DigestService(mail as any, redis as any, queue as any);
  processor = new PaymentEventsProcessor(mail as any, sms as any, digest, redis as any);
});

describe('digest', () => {
  it('collects Delayed/Default changes in Redis and sends them as one email on flush', async () => {
    await processor.process({ name: 'obligation.status_changed', data: { type: 'obligation.status_changed', data: change(1), occurredAt: '' } } as any);
    await processor.process({ name: 'obligation.status_changed', data: { type: 'obligation.status_changed', data: change(2, 'Default'), occurredAt: '' } } as any);
    expect(queue.add).toHaveBeenCalledWith(DIGEST_FLUSH_JOB, {}, expect.objectContaining({ jobId: expect.stringMatching(/^digest-flush-\d+$/) }));
    expect(mail.sendToAlertRecipients).not.toHaveBeenCalled();

    await processor.process({ name: DIGEST_FLUSH_JOB, data: {} } as any);

    expect(mail.sendToAlertRecipients).toHaveBeenCalledTimes(1);
    const [subject, body] = mail.sendToAlertRecipients.mock.calls[0];
    expect(subject).toBe('[Monsera] 2 obligation(s) moved to Delayed/Default (1 Default)');
    expect(body).toContain('meter MT-1: Watch -> Delayed');
    expect(await digest.flush()).toBe(0); // nothing left
  });

  it('ignores status changes that are not Delayed or Default', async () => {
    await processor.process({ name: 'obligation.status_changed', data: { type: 'obligation.status_changed', data: change(1, 'Watch'), occurredAt: '' } } as any);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('keeps the changes, in order, when the email fails, so the retry sends them', async () => {
    await digest.add(change(1));
    await digest.add(change(2));
    mail.sendToAlertRecipients.mockRejectedValueOnce(new Error('SMTP down'));

    await expect(digest.flush()).rejects.toThrow('SMTP down');
    expect(await digest.flush()).toBe(2);
    expect(mail.sendToAlertRecipients.mock.calls[1][1].indexOf('MT-1')).toBeLessThan(mail.sendToAlertRecipients.mock.calls[1][1].indexOf('MT-2'));
  });
});

describe('ops alerts', () => {
  const alert = (severity = 'warning', title = 'payments: low_balance') => ({
    name: 'ops.alert',
    data: { type: 'ops.alert', data: { severity, title, message: 'Wallet A low' }, occurredAt: '2026-11-24T00:00:00Z' },
  }) as any;

  it('emails once per title within the cooldown, across processors sharing Redis', async () => {
    const other = new PaymentEventsProcessor(mail as any, sms as any, digest, redis as any);
    await processor.process(alert());
    await other.process(alert()); // a second instance
    expect(mail.sendToAlertRecipients).toHaveBeenCalledTimes(1);
  });

  it('releases the cooldown when the email fails, so the retry sends it', async () => {
    mail.sendToAlertRecipients.mockRejectedValueOnce(new Error('SMTP down'));
    await expect(processor.process(alert())).rejects.toThrow('SMTP down');
    await processor.process(alert());
    expect(mail.sendToAlertRecipients).toHaveBeenCalledTimes(2);
  });

  it('texts critical alerts and does not fail the job if an SMS fails', async () => {
    process.env.ALERT_PHONE_NUMBERS = '+2348000000000';
    sms.send.mockRejectedValueOnce(new Error('provider down'));
    await processor.process(alert('critical', 'payments: daily-sweep'));
    delete process.env.ALERT_PHONE_NUMBERS;
    expect(sms.send).toHaveBeenCalledWith('+2348000000000', '[Monsera] payments: daily-sweep');
  });
});

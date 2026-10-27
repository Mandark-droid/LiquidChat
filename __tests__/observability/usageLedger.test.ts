import { savedUsd, usageLedger } from '../../src/observability/usageLedger';

describe('offline usage ledger', () => {
  it('counts on-device and cloud tokens separately and prices what stayed local', async () => {
    await usageLedger.reset();
    usageLedger.record('local', 1_000_000, 500_000);
    usageLedger.record('remote', 2_000, 1_000);
    usageLedger.record('local', undefined, Number.NaN); // providers that report nothing add nothing
    await new Promise(r => setTimeout(r, 0));
    const t = await usageLedger.get();
    expect(t).toMatchObject({
      localInput: 1_000_000,
      localOutput: 500_000,
      localCalls: 2,
      remoteInput: 2_000,
      remoteOutput: 1_000,
      remoteCalls: 1,
    });
    expect(savedUsd(t)).toBeCloseTo(0.15 + 0.3);
  });
});

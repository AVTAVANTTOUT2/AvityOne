// A local quota boundary fixture. No provider, network or real credentials.
if (process.env.QUOTA_MODE === 'timeout') await new Promise((resolve) => setTimeout(resolve, 20_000));
if (process.env.QUOTA_MODE === 'error') { process.stderr.write('synthetic-private-provider-key'); process.exit(1); }
process.stdout.write(process.env.QUOTA_JSON ?? JSON.stringify({ remaining: 12, limit: 100, unit: 'requests' }));

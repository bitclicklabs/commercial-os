import { describe, expect, it } from 'vitest';
import { isLocalRequest } from '../../src/api/routes/metrics.js';

const req = (ip: string, host?: string) => ({ ip, headers: host === undefined ? {} : { host } });

describe('isLocalRequest (GET /dashboard guard)', () => {
  it('accepts loopback clients that address this machine', () => {
    expect(isLocalRequest(req('127.0.0.1', '127.0.0.1:4020'))).toBe(true);
    expect(isLocalRequest(req('::1', 'localhost:4020'))).toBe(true);
    expect(isLocalRequest(req('::ffff:127.0.0.1', '[::1]:4020'))).toBe(true);
    expect(isLocalRequest(req('127.0.0.1', 'runtime.localhost'))).toBe(true);
  });

  it('accepts the Docker bridge gateway (port published on 127.0.0.1)', () => {
    expect(isLocalRequest(req('172.18.0.1', 'localhost:4020'))).toBe(true);
    expect(isLocalRequest(req('::ffff:192.168.65.1', '127.0.0.1:4020'))).toBe(true);
  });

  it('rejects public clients and foreign Host headers (DNS rebinding)', () => {
    expect(isLocalRequest(req('203.0.113.7', '127.0.0.1:4020'))).toBe(false);
    expect(isLocalRequest(req('127.0.0.1', 'evil.example:4020'))).toBe(false);
    expect(isLocalRequest(req('127.0.0.1', 'localhost.evil.example'))).toBe(false);
    expect(isLocalRequest(req('127.0.0.1'))).toBe(false);
  });
});

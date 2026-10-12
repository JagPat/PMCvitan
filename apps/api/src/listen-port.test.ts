import { describe, it, expect } from 'vitest';
import { listenPort } from './listen-port';

describe('listenPort', () => {
  it('uses a numeric PORT and falls back to 3000 for empty, zero, or non-numeric values', () => {
    expect(listenPort({ PORT: '3999' })).toBe(3999);
    expect(listenPort({})).toBe(3000);
    expect(listenPort({ PORT: '' })).toBe(3000);
    expect(listenPort({ PORT: '0' })).toBe(3000);
    expect(listenPort({ PORT: 'nope' })).toBe(3000);
  });
});

import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/index.js';

describe('aidaily cli', () => {
  it('exposes version 0.1.0', () => {
    const program = buildProgram();
    expect(program.version()).toBe('0.1.0');
  });
});

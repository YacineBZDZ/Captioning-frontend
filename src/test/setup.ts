import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());

// jsdom does not implement object URLs.
if (!URL.createObjectURL) {
  let n = 0;
  URL.createObjectURL = () => `blob:mock/${++n}`;
  URL.revokeObjectURL = () => undefined;
}

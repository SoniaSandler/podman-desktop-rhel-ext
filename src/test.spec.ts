// import '@testing-library/jest-dom/vitest';

import { expect, test } from 'vitest';

test('(should fail) fixed test should pass', () => {
  expect(5).toBeGreaterThan(3);
});

test('should pass', () => {
  expect(5).toEqual(5);
});
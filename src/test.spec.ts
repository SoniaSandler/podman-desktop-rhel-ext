// import '@testing-library/jest-dom/vitest';

import { expect, test } from 'vitest';

test('should fail', () => {
  expect(5).toEqual(3);
});

test('should pass', () => {
  expect(5).toEqual(5);
});
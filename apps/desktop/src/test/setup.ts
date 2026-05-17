// TRA-409 — global test setup for the desktop suite.
//
// Registers @testing-library/jest-dom matchers (toBeInTheDocument, toHaveFocus,
// ...) and clears the rendered DOM + mocks between tests so suites stay isolated.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

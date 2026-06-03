// TRA-409 — global test setup for the desktop suite.
//
// Registers @testing-library/jest-dom matchers (toBeInTheDocument, toHaveFocus,
// ...) and clears the rendered DOM + mocks between tests so suites stay isolated.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom does not implement Element.scrollIntoView; components that call it (e.g.
// the TRA-569 coach-mark tour bringing an anchor into view) would otherwise throw
// during tests. Stub it as a no-op.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

afterEach(() => {
  cleanup();
});

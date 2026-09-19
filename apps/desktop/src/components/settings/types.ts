// TRA-4729 — moved verbatim out of SettingsPage.tsx; no behaviour change.


export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
export type PwStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface SafeUser {
  username: string;
  email: string;
  role: 'admin' | 'user';
  createdAt: string;
  // TRA-217 — admin lock toggle. Optional for back-compat with old payloads.
  locked?: boolean;
}


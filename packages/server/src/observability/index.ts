// TRA-406 — observability barrel.
//
// Structured logging, per-request trace correlation, error telemetry, a trade
// audit log and basic alerting. See the individual modules and `docs/
// observability.md` for the operational runbook.

export { logger, LOG_DIR, flushLogs, setFileSinkEnabled } from './logger.js';
export type { Logger, LogLevel, LogFields } from './logger.js';

export {
  traceMiddleware,
  runWithTrace,
  getTraceContext,
  setTraceUser,
  newTraceId,
} from './trace.js';
export type { TraceContext } from './trace.js';

export {
  captureException,
  installGlobalErrorHandlers,
  errorMiddleware,
  getErrorCountSince,
} from './errors.js';
export type { ErrorRecord } from './errors.js';

export { recordTradeAudit, TradeAuditTracker, getTradeOpenCount } from './audit.js';
export type { TradeAuditEntry, AuditEngine, AuditStateLike } from './audit.js';

export {
  dispatchAlert,
  getRecentAlerts,
  runHealthCheck,
  checkDiskSpace,
  recordBootAndCheckRestarts,
  checkTradeVolume,
  checkErrorSpike,
  __resetAlertsForTest,
} from './alerts.js';
export type { Alert, AlertKey, AlertSeverity, DiskReading } from './alerts.js';

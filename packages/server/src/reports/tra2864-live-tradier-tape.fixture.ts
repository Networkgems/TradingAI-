// GENERATED FROM REAL BROKER DATA -- do not hand-edit; see TRA-2864.
//
// Verbatim Tradier LIVE PRODUCTION account activity, exported by the board and
// attached to TRA-2864 (`activity.csv`), normalised into the shape
// `parseTradierHistory` produces. Every `description` here is exactly what
// Tradier production returned -- note that NOT ONE of them carries a
// "Buy to Open" / "Sell to Close" action prefix. That is the whole point of
// the fixture: a synthetic tape written by hand always has the prefix, which is
// why every unit test passed while the live account booked nothing.
//
// The expectations below are Tradier's OWN gain/loss report (`gainloss.csv`,
// same upload) -- an independently computed second source, not our own output
// snapshotted back at us.

import type { TradierTradeHistoryFill } from '@trading-app/engine';

/** Newest-first, as `/accounts/{id}/history` returns it. */
export const LIVE_TRADIER_TAPE: TradierTradeHistoryFill[] = [
  { date: '2026-08-03', symbol: 'AMZN260904C00295000', tradeType: 'option', description: 'AMZN Sep 4, 2026 $295.00 Call', price: 6.19, quantity: 1, amount: 618.86, commission: 0, transactionId: 'tx-000', orderId: null },
  { date: '2026-08-03', symbol: 'AMZN260904P00245000', tradeType: 'option', description: 'AMZN Sep 4, 2026 $245.00 Put', price: 0.89, quantity: 1, amount: 88.87, commission: 0, transactionId: 'tx-001', orderId: null },
  { date: '2026-08-03', symbol: 'QQQ260904C00797000', tradeType: 'option', description: 'QQQ Sep 4, 2026 $797.00 Call', price: 0.18, quantity: 4, amount: 71.56, commission: 0, transactionId: 'tx-002', orderId: null },
  { date: '2026-07-31', symbol: 'SPY260904C00816000', tradeType: 'option', description: 'SPY Sep 4, 2026 $816.00 Call', price: 0.12, quantity: 3, amount: 35.66, commission: 0, transactionId: 'tx-003', orderId: null },
  { date: '2026-07-31', symbol: 'AMZN260904C00295000', tradeType: 'option', description: 'AMZN Sep 4, 2026 $295.00 Call', price: 2.9, quantity: 1, amount: -290.11, commission: 0, transactionId: 'tx-004', orderId: null },
  { date: '2026-07-31', symbol: 'QQQ260904C00797000', tradeType: 'option', description: 'QQQ Sep 4, 2026 $797.00 Call', price: 0.34, quantity: 4, amount: -136.42, commission: 0, transactionId: 'tx-005', orderId: null },
  { date: '2026-07-31', symbol: 'AAPL260904P00280000', tradeType: 'option', description: 'AAPL Sep 4, 2026 $280.00 Put', price: 2.78, quantity: 1, amount: 277.87, commission: 0, transactionId: 'tx-006', orderId: null },
  { date: '2026-07-31', symbol: 'SPY260904C00820000', tradeType: 'option', description: 'SPY Sep 4, 2026 $820.00 Call', price: 0.1, quantity: 2, amount: 19.75, commission: 0, transactionId: 'tx-007', orderId: null },
  { date: '2026-07-31', symbol: 'AMZN260904P00245000', tradeType: 'option', description: 'AMZN Sep 4, 2026 $245.00 Put', price: 2.78, quantity: 1, amount: -278.11, commission: 0, transactionId: 'tx-008', orderId: null },
  { date: '2026-07-31', symbol: 'AAPL260904P00280000', tradeType: 'option', description: 'AAPL Sep 4, 2026 $280.00 Put', price: 2.78, quantity: 3, amount: 833.64, commission: 0, transactionId: 'tx-009', orderId: null },
  { date: '2026-07-31', symbol: 'SPY260904C00816000', tradeType: 'option', description: 'SPY Sep 4, 2026 $816.00 Call', price: 0.12, quantity: 1, amount: 11.87, commission: 0, transactionId: 'tx-010', orderId: null },
  { date: '2026-07-30', symbol: 'AAPL260904P00280000', tradeType: 'option', description: 'AAPL Sep 4, 2026 $280.00 Put', price: 1.04, quantity: 4, amount: -416.42, commission: 0, transactionId: 'tx-011', orderId: null },
  { date: '2026-07-30', symbol: 'SPY260904C00816000', tradeType: 'option', description: 'SPY Sep 4, 2026 $816.00 Call', price: 0.08, quantity: 4, amount: -32.42, commission: 0, transactionId: 'tx-012', orderId: null },
  { date: '2026-07-30', symbol: 'SPY260904C00820000', tradeType: 'option', description: 'SPY Sep 4, 2026 $820.00 Call', price: 0.08, quantity: 2, amount: -16.22, commission: 0, transactionId: 'tx-013', orderId: null },
  { date: '2026-07-08', symbol: 'QQQ260709C00714000', tradeType: 'option', description: 'QQQ Jul 9, 2026 $714.00 Call', price: 1.68, quantity: 1, amount: 167.87, commission: 0, transactionId: 'tx-014', orderId: null },
  { date: '2026-07-07', symbol: 'QQQ260709C00714000', tradeType: 'option', description: 'QQQ Jul 9, 2026 $714.00 Call', price: 2.74, quantity: 1, amount: -274.11, commission: 0, transactionId: 'tx-015', orderId: null },
  { date: '2026-07-01', symbol: 'SPY260717P00710000', tradeType: 'option', description: 'SPY Jul 17, 2026 $710.00 Put', price: 1.39, quantity: 1, amount: 138.87, commission: 0, transactionId: 'tx-016', orderId: null },
  { date: '2026-07-01', symbol: 'HOOD260717P00090000', tradeType: 'option', description: 'HOOD Jul 17, 2026 $90.00 Put', price: 1.38, quantity: 1, amount: 137.87, commission: 0, transactionId: 'tx-017', orderId: null },
  { date: '2026-06-29', symbol: 'SPY260717P00710000', tradeType: 'option', description: 'SPY Jul 17, 2026 $710.00 Put', price: 2.2, quantity: 1, amount: -220.11, commission: 0, transactionId: 'tx-018', orderId: null },
  { date: '2026-06-29', symbol: 'HOOD260717P00090000', tradeType: 'option', description: 'HOOD Jul 17, 2026 $90.00 Put', price: 1.73, quantity: 1, amount: -173.11, commission: 0, transactionId: 'tx-019', orderId: null },
  { date: '2026-06-25', symbol: 'MSFT260821C00480000', tradeType: 'option', description: 'MSFT Aug 21, 2026 $480.00 Call', price: 1.8, quantity: 1, amount: 179.87, commission: 0, transactionId: 'tx-020', orderId: null },
  { date: '2026-06-25', symbol: 'PSKY260731C00010500', tradeType: 'option', description: 'PSKY Jul 31, 2026 $10.50 Call', price: 0.35, quantity: 6, amount: 209.32, commission: 0, transactionId: 'tx-021', orderId: null },
  { date: '2026-06-18', symbol: 'PSKY260731C00010500', tradeType: 'option', description: 'PSKY Jul 31, 2026 $10.50 Call', price: 0.53, quantity: 2, amount: -106.22, commission: 0, transactionId: 'tx-022', orderId: null },
  { date: '2026-06-17', symbol: 'PSKY260731C00010500', tradeType: 'option', description: 'PSKY Jul 31, 2026 $10.50 Call', price: 0.62, quantity: 2, amount: -124.22, commission: 0, transactionId: 'tx-023', orderId: null },
  { date: '2026-06-17', symbol: 'MSFT260821C00480000', tradeType: 'option', description: 'MSFT Aug 21, 2026 $480.00 Call', price: 4.1, quantity: 1, amount: -410.11, commission: 0, transactionId: 'tx-024', orderId: null },
  { date: '2026-06-16', symbol: 'TSLA260717P00210000', tradeType: 'option', description: 'TSLA Jul 17, 2026 $210.00 Put', price: 0.2, quantity: 4, amount: 79.53, commission: 0, transactionId: 'tx-025', orderId: null },
  { date: '2026-06-16', symbol: 'PSKY260731C00010500', tradeType: 'option', description: 'PSKY Jul 31, 2026 $10.50 Call', price: 0.79, quantity: 2, amount: -158.23, commission: 0, transactionId: 'tx-026', orderId: null },
  { date: '2026-06-16', symbol: 'MIR', tradeType: 'equity', description: 'MIR', price: 17.47, quantity: 1, amount: 17.44, commission: 0, transactionId: 'tx-027', orderId: null },
  { date: '2026-06-16', symbol: 'SPY260617P00752000', tradeType: 'option', description: 'SPY Jun 17, 2026 $752.00 Put', price: 1.54, quantity: 1, amount: 153.87, commission: 0, transactionId: 'tx-028', orderId: null },
  { date: '2026-06-15', symbol: 'SPY260617P00752000', tradeType: 'option', description: 'SPY Jun 17, 2026 $752.00 Put', price: 2.42, quantity: 1, amount: -242.11, commission: 0, transactionId: 'tx-029', orderId: null },
  { date: '2026-06-15', symbol: 'HOOD260626C00100000', tradeType: 'option', description: 'HOOD Jun 26, 2026 $100.00 Call', price: 3.84, quantity: 1, amount: -384.11, commission: 0, transactionId: 'tx-030', orderId: null },
  { date: '2026-06-15', symbol: 'TSLA260717P00210000', tradeType: 'option', description: 'TSLA Jul 17, 2026 $210.00 Put', price: 0.31, quantity: 1, amount: -31.11, commission: 0, transactionId: 'tx-031', orderId: null },
  { date: '2026-06-15', symbol: 'HOOD260626C00100000', tradeType: 'option', description: 'HOOD Jun 26, 2026 $100.00 Call', price: 5.1, quantity: 1, amount: 509.86, commission: 0, transactionId: 'tx-032', orderId: null },
  { date: '2026-06-12', symbol: 'META260717P00450000', tradeType: 'option', description: 'META Jul 17, 2026 $450.00 Put', price: 0.96, quantity: 1, amount: 95.87, commission: 0, transactionId: 'tx-033', orderId: null },
  { date: '2026-06-12', symbol: 'AAPL260717C00310000', tradeType: 'option', description: 'AAPL Jul 17, 2026 $310.00 Call', price: 2.28, quantity: 1, amount: 227.87, commission: 0, transactionId: 'tx-034', orderId: null },
  { date: '2026-06-12', symbol: 'MIR', tradeType: 'equity', description: 'MIR', price: 16.63, quantity: 1, amount: -16.64, commission: 0, transactionId: 'tx-035', orderId: null },
  { date: '2026-06-12', symbol: 'RKLB260717C00210000', tradeType: 'option', description: 'RKLB Jul 17, 2026 $210.00 Call', price: 0.75, quantity: 1, amount: 74.87, commission: 0, transactionId: 'tx-036', orderId: null },
  { date: '2026-06-11', symbol: 'META260717P00450000', tradeType: 'option', description: 'META Jul 17, 2026 $450.00 Put', price: 1.28, quantity: 1, amount: -128.11, commission: 0, transactionId: 'tx-037', orderId: null },
  { date: '2026-06-11', symbol: 'GOOGL260717P00285000', tradeType: 'option', description: 'GOOGL Jul 17, 2026 $285.00 Put', price: 0.89, quantity: 1, amount: 88.87, commission: 0, transactionId: 'tx-038', orderId: null },
  { date: '2026-06-11', symbol: 'TSLA260717P00245000', tradeType: 'option', description: 'TSLA Jul 17, 2026 $245.00 Put', price: 0.81, quantity: 1, amount: 80.87, commission: 0, transactionId: 'tx-039', orderId: null },
  { date: '2026-06-11', symbol: 'TSLA260717P00210000', tradeType: 'option', description: 'TSLA Jul 17, 2026 $210.00 Put', price: 0.41, quantity: 3, amount: -123.33, commission: 0, transactionId: 'tx-040', orderId: null },
  { date: '2026-06-11', symbol: 'MOS261218C00021000', tradeType: 'option', description: 'MOS Dec 18, 2026 $21.00 Call', price: 2.61, quantity: 1, amount: 260.87, commission: 0, transactionId: 'tx-041', orderId: null },
  { date: '2026-06-11', symbol: 'RKLB260717C00210000', tradeType: 'option', description: 'RKLB Jul 17, 2026 $210.00 Call', price: 0.87, quantity: 1, amount: -87.11, commission: 0, transactionId: 'tx-042', orderId: null },
  { date: '2026-06-11', symbol: 'AAPL260717C00310000', tradeType: 'option', description: 'AAPL Jul 17, 2026 $310.00 Call', price: 3.25, quantity: 1, amount: -325.11, commission: 0, transactionId: 'tx-043', orderId: null },
  { date: '2026-06-10', symbol: 'GOOGL260717P00285000', tradeType: 'option', description: 'GOOGL Jul 17, 2026 $285.00 Put', price: 0.93, quantity: 1, amount: -93.11, commission: 0, transactionId: 'tx-044', orderId: null },
  { date: '2026-06-10', symbol: 'MOS261218C00021000', tradeType: 'option', description: 'MOS Dec 18, 2026 $21.00 Call', price: 3.4, quantity: 1, amount: -340.11, commission: 0, transactionId: 'tx-045', orderId: null },
  { date: '2026-06-10', symbol: 'TSLA260717P00245000', tradeType: 'option', description: 'TSLA Jul 17, 2026 $245.00 Put', price: 0.78, quantity: 1, amount: -78.11, commission: 0, transactionId: 'tx-046', orderId: null },
  { date: '2026-06-09', symbol: 'CHWY260612P00018500', tradeType: 'option', description: 'CHWY Jun 12, 2026 $18.50 Put', price: 0.33, quantity: 2, amount: 65.75, commission: 0, transactionId: 'tx-047', orderId: null },
  { date: '2026-06-09', symbol: 'MSFT260717C00550000', tradeType: 'option', description: 'MSFT Jul 17, 2026 $550.00 Call', price: 0.21, quantity: 2, amount: 41.75, commission: 0, transactionId: 'tx-048', orderId: null },
  { date: '2026-06-09', symbol: 'CIFR', tradeType: 'equity', description: 'CIFR', price: 23.85, quantity: 1, amount: 23.82, commission: 0, transactionId: 'tx-049', orderId: null },
  { date: '2026-06-09', symbol: 'IREN', tradeType: 'equity', description: 'IREN', price: 60.64, quantity: 1, amount: -60.65, commission: 0, transactionId: 'tx-050', orderId: null },
  { date: '2026-06-09', symbol: 'CIFR', tradeType: 'equity', description: 'CIFR', price: 25.12, quantity: 1, amount: -25.13, commission: 0, transactionId: 'tx-051', orderId: null },
  { date: '2026-06-09', symbol: 'RKLB260717C00210000', tradeType: 'option', description: 'RKLB Jul 17, 2026 $210.00 Call', price: 1.11, quantity: 1, amount: 110.87, commission: 0, transactionId: 'tx-052', orderId: null },
  { date: '2026-06-09', symbol: 'INTC', tradeType: 'equity', description: 'INTC', price: 110.3, quantity: 1, amount: 110.27, commission: 0, transactionId: 'tx-053', orderId: null },
  { date: '2026-06-09', symbol: 'TDIC', tradeType: 'equity', description: 'TDIC', price: 0.3947, quantity: 5, amount: -1.98, commission: 0, transactionId: 'tx-054', orderId: null },
  { date: '2026-06-09', symbol: 'RIOT260618C00025000', tradeType: 'option', description: 'RIOT Jun 18, 2026 $25.00 Call', price: 2.7, quantity: 1, amount: 269.87, commission: 0, transactionId: 'tx-055', orderId: null },
  { date: '2026-06-09', symbol: 'GM', tradeType: 'equity', description: 'GM', price: 83.7, quantity: 1, amount: 83.67, commission: 0, transactionId: 'tx-056', orderId: null },
  { date: '2026-06-09', symbol: 'MSFT260717C00550000', tradeType: 'option', description: 'MSFT Jul 17, 2026 $550.00 Call', price: 0.24, quantity: 1, amount: 23.87, commission: 0, transactionId: 'tx-057', orderId: null },
  { date: '2026-06-09', symbol: 'IREN', tradeType: 'equity', description: 'IREN', price: 58.28, quantity: 1, amount: 58.25, commission: 0, transactionId: 'tx-058', orderId: null },
  { date: '2026-06-09', symbol: 'CHWY260612P00018500', tradeType: 'option', description: 'CHWY Jun 12, 2026 $18.50 Put', price: 0.22, quantity: 2, amount: 43.75, commission: 0, transactionId: 'tx-059', orderId: null },
  { date: '2026-06-09', symbol: 'GM', tradeType: 'equity', description: 'GM', price: 84.32, quantity: 1, amount: -84.33, commission: 0, transactionId: 'tx-060', orderId: null },
  { date: '2026-06-09', symbol: 'INTC', tradeType: 'equity', description: 'INTC', price: 112.36, quantity: 1, amount: -112.37, commission: 0, transactionId: 'tx-061', orderId: null },
  { date: '2026-06-09', symbol: 'RKLB', tradeType: 'equity', description: 'RKLB', price: 115.61, quantity: 1, amount: -115.62, commission: 0, transactionId: 'tx-062', orderId: null },
  { date: '2026-06-09', symbol: 'RKLB', tradeType: 'equity', description: 'RKLB', price: 111.75, quantity: 1, amount: 111.72, commission: 0, transactionId: 'tx-063', orderId: null },
  { date: '2026-06-08', symbol: 'CHWY260612P00018500', tradeType: 'option', description: 'CHWY Jun 12, 2026 $18.50 Put', price: 0.36, quantity: 2, amount: -72.23, commission: 0, transactionId: 'tx-064', orderId: null },
  { date: '2026-06-08', symbol: 'RDW', tradeType: 'equity', description: 'RDW', price: 18.65, quantity: 1, amount: 18.62, commission: 0, transactionId: 'tx-065', orderId: null },
  { date: '2026-06-08', symbol: 'RDW', tradeType: 'equity', description: 'RDW', price: 18.77, quantity: 1, amount: -18.78, commission: 0, transactionId: 'tx-066', orderId: null },
  { date: '2026-06-08', symbol: 'LASE', tradeType: 'equity', description: 'LASE', price: 3.3699, quantity: 2, amount: -6.75, commission: 0, transactionId: 'tx-067', orderId: null },
  { date: '2026-06-08', symbol: 'LASE', tradeType: 'equity', description: 'LASE', price: 3.32, quantity: 2, amount: 6.61, commission: 0, transactionId: 'tx-068', orderId: null },
  { date: '2026-06-08', symbol: 'CHWY260612P00018500', tradeType: 'option', description: 'CHWY Jun 12, 2026 $18.50 Put', price: 0.43, quantity: 2, amount: -86.23, commission: 0, transactionId: 'tx-069', orderId: null },
  { date: '2026-06-08', symbol: 'RIOT260618C00025000', tradeType: 'option', description: 'RIOT Jun 18, 2026 $25.00 Call', price: 1.51, quantity: 1, amount: -151.11, commission: 0, transactionId: 'tx-070', orderId: null },
  { date: '2026-06-08', symbol: 'TDIC', tradeType: 'equity', description: 'TDIC', price: 0.5199, quantity: 2, amount: -1.05, commission: 0, transactionId: 'tx-071', orderId: null },
  { date: '2026-06-08', symbol: 'RKLB260717C00210000', tradeType: 'option', description: 'RKLB Jul 17, 2026 $210.00 Call', price: 1.05, quantity: 1, amount: -105.11, commission: 0, transactionId: 'tx-072', orderId: null },
  { date: '2026-06-08', symbol: 'MSFT260717C00550000', tradeType: 'option', description: 'MSFT Jul 17, 2026 $550.00 Call', price: 0.43, quantity: 3, amount: -129.33, commission: 0, transactionId: 'tx-073', orderId: null },
  { date: '2026-06-04', symbol: 'NU260821C00014000', tradeType: 'option', description: 'NU Aug 21, 2026 $14.00 Call', price: 0.58, quantity: 3, amount: 173.65, commission: 0, transactionId: 'tx-074', orderId: null },
  { date: '2026-06-04', symbol: 'NVDA260618C00240000', tradeType: 'option', description: 'NVDA Jun 18, 2026 $240.00 Call', price: 0.68, quantity: 1, amount: 67.87, commission: 0, transactionId: 'tx-075', orderId: null },
  { date: '2026-06-04', symbol: 'NVDA260618C00250000', tradeType: 'option', description: 'NVDA Jun 18, 2026 $250.00 Call', price: 0.34, quantity: 2, amount: 67.75, commission: 0, transactionId: 'tx-076', orderId: null },
  { date: '2026-06-04', symbol: 'NVDA260605C00230000', tradeType: 'option', description: 'NVDA Jun 5, 2026 $230.00 Call', price: 0.05, quantity: 4, amount: 19.55, commission: 0, transactionId: 'tx-077', orderId: null },
  { date: '2026-06-03', symbol: 'NVDA260618C00250000', tradeType: 'option', description: 'NVDA Jun 18, 2026 $250.00 Call', price: 0.6, quantity: 1, amount: -60.11, commission: 0, transactionId: 'tx-078', orderId: null },
  { date: '2026-06-03', symbol: 'NVDA260605C00230000', tradeType: 'option', description: 'NVDA Jun 5, 2026 $230.00 Call', price: 0.24, quantity: 4, amount: -96.43, commission: 0, transactionId: 'tx-079', orderId: null },
  { date: '2026-06-03', symbol: 'NU260821C00014000', tradeType: 'option', description: 'NU Aug 21, 2026 $14.00 Call', price: 0.35, quantity: 3, amount: -105.33, commission: 0, transactionId: 'tx-080', orderId: null },
  { date: '2026-06-03', symbol: 'NVDA260618C00240000', tradeType: 'option', description: 'NVDA Jun 18, 2026 $240.00 Call', price: 1.24, quantity: 1, amount: -124.11, commission: 0, transactionId: 'tx-081', orderId: null },
  { date: '2026-06-02', symbol: 'NVDA260618C00250000', tradeType: 'option', description: 'NVDA Jun 18, 2026 $250.00 Call', price: 1.23, quantity: 1, amount: -123.11, commission: 0, transactionId: 'tx-082', orderId: null },
  { date: '2026-05-27', symbol: 'SOFI260918C00022000', tradeType: 'option', description: 'SOFI Sep 18, 2026 $22.00 Call', price: 0.83, quantity: 2, amount: 165.75, commission: 0, transactionId: 'tx-083', orderId: null },
  { date: '2026-05-20', symbol: 'TSLA260618P00160000', tradeType: 'option', description: 'TSLA Jun 18, 2026 $160.00 Put', price: 0.07, quantity: 1, amount: 6.87, commission: 0, transactionId: 'tx-084', orderId: null },
  { date: '2026-05-20', symbol: 'TSLA260618P00140000', tradeType: 'option', description: 'TSLA Jun 18, 2026 $140.00 Put', price: 0.04, quantity: 1, amount: 3.87, commission: 0, transactionId: 'tx-085', orderId: null },
  { date: '2026-05-20', symbol: 'NVDA260618P00081000', tradeType: 'option', description: 'NVDA Jun 18, 2026 $81.00 Put', price: 0.01, quantity: 1, amount: 0.87, commission: 0, transactionId: 'tx-086', orderId: null },
  { date: '2026-05-20', symbol: 'NVDA260618P00084000', tradeType: 'option', description: 'NVDA Jun 18, 2026 $84.00 Put', price: 0.02, quantity: 1, amount: 1.87, commission: 0, transactionId: 'tx-087', orderId: null },
  { date: '2026-05-20', symbol: 'NVDA260618P00107000', tradeType: 'option', description: 'NVDA Jun 18, 2026 $107.00 Put', price: 0.03, quantity: 1, amount: 2.87, commission: 0, transactionId: 'tx-088', orderId: null },
];

/**
 * Realized options P&L per CLOSE date, straight off Tradier's own gain/loss
 * report for this account (19 closed option lots). This is broker truth; any
 * disagreement is ours.
 *
 * The report covers closes through 2026-07-31 only, so days the activity tape
 * shows closing on (e.g. 2026-08-03) are absent here rather than zero -- the
 * tests assert over these keys, never over the tape's full date range.
 */
export const TRADIER_GAINLOSS_BY_CLOSE_DATE: Record<string, number> = {
  '2026-06-12': -141.72,
  '2026-06-15': 125.75,
  '2026-06-16': -163.15,
  '2026-06-25': -409.59,
  '2026-07-01': -116.48,
  '2026-07-08': -106.24,
  '2026-07-31': 713.73,
};

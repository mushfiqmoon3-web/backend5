/**
 * Default Trading Pairs Configuration
 * All pairs are in USDT format for Binance/Bybit
 */

export const DEFAULT_TRADING_PAIRS = [
  'BTCUSDT',   // Bitcoin
  'ETHUSDT',   // Ethereum
  'XRPUSDT',   // XRP
  'BNBUSDT',   // BNB
  'SOLUSDT',   // Solana
  'TRXUSDT',   // TRON
  'DOGEUSDT',  // Dogecoin
  'ADAUSDT',   // Cardano
  'SHIBUSDT',  // Shiba Inu
  'AVAXUSDT',  // Avalanche
  'BCHUSDT',   // Bitcoin Cash
  'DOTUSDT',   // Polkadot
  'LINKUSDT',  // Chainlink
  'NEARUSDT',  // Near Protocol
  'MATICUSDT', // Polygon (MATIC)
  'TONUSDT',   // Toncoin
  'LTCUSDT',   // Litecoin
  'SUIUSDT',   // Sui
] as const;

/**
 * Popular trading pairs (Top 10)
 */
export const POPULAR_PAIRS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'DOTUSDT',
  'LINKUSDT',
] as const;

/**
 * Get all available trading pairs
 */
export function getAllTradingPairs(): string[] {
  return [...DEFAULT_TRADING_PAIRS];
}

/**
 * Validate if a pair is supported
 */
export function isPairSupported(pair: string): boolean {
  return DEFAULT_TRADING_PAIRS.includes(pair.toUpperCase() as typeof DEFAULT_TRADING_PAIRS[number]);
}


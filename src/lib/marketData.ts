export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export async function fetchBinanceKlines(
  symbol: string,
  interval: string,
  isTestnet: boolean,
  product: string,
  limit: number = 100
): Promise<Candle[]> {
  let baseUrl: string;
  
  if (product === 'futures') {
    baseUrl = isTestnet 
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';
  } else {
    baseUrl = isTestnet
      ? 'https://testnet.binance.vision'
      : 'https://api.binance.com';
  }

  const endpoint = product === 'futures' ? '/fapi/v1/klines' : '/api/v3/klines';
  const params = new URLSearchParams({
    symbol: symbol.toUpperCase(),
    interval,
    limit: String(limit),
  });
  const url = `${baseUrl}${endpoint}?${params.toString()}`;

  try {
    const response = await fetch(url);
    const data = await response.json() as unknown[] | { code?: number; msg?: string };
    if (!response.ok) {
      const errMsg = typeof data === 'object' && data !== null && !Array.isArray(data) && 'msg' in data
        ? (data as { msg?: string }).msg
        : response.statusText;
      console.error(
        `Binance API error for ${symbol}: ${response.status} ${response.statusText}`,
        errMsg ? `— ${errMsg}` : '',
        typeof data === 'object' && data !== null && !Array.isArray(data) && 'code' in data
          ? `(code: ${(data as { code?: number }).code})`
          : ''
      );
      return [];
    }
    if (!Array.isArray(data)) {
      console.error(`Invalid kline data for ${symbol}:`, typeof data, data);
      return [];
    }

    if (data.length === 0) {
      console.warn(`No kline data returned for ${symbol}`);
      return [];
    }
    
    return data.map((k: unknown) => {
      const kline = k as unknown[];
      return {
        open: parseFloat(String(kline[1])),
        high: parseFloat(String(kline[2])),
        low: parseFloat(String(kline[3])),
        close: parseFloat(String(kline[4])),
        volume: parseFloat(String(kline[5])),
        timestamp: Number(kline[0]),
      };
    });
  } catch (error) {
    console.error(`Error fetching Binance klines for ${symbol}:`, error);
    return [];
  }
}

export async function fetchBybitKlines(
  symbol: string,
  interval: string,
  isTestnet: boolean,
  limit: number = 100
): Promise<Candle[]> {
  const baseUrl = isTestnet
    ? 'https://api-testnet.bybit.com'
    : 'https://api.bybit.com';
  
  const url = `${baseUrl}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Bybit API error for ${symbol}: ${response.status} ${response.statusText}`);
      return [];
    }
    const data = await response.json() as { retCode?: number; retMsg?: string; result?: { list?: string[][] } };
    
    if (data.retCode !== 0 || !data.result?.list) {
      console.error(`Invalid Bybit kline data for ${symbol}: retCode=${data.retCode}, retMsg=${data.retMsg}`);
      return [];
    }
    
    if (data.result.list.length === 0) {
      console.warn(`No kline data returned for ${symbol}`);
      return [];
    }
    
    // Bybit returns newest first, reverse it
    return data.result.list.reverse().map((k: string[]) => ({
      timestamp: parseInt(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  } catch (error) {
    console.error(`Error fetching Bybit klines for ${symbol}:`, error);
    return [];
  }
}

export async function fetchKlines(
  exchange: string,
  symbol: string,
  interval: string,
  isTestnet: boolean,
  product: string,
  limit: number = 100
): Promise<Candle[]> {
  if (exchange === 'binance') {
    return fetchBinanceKlines(symbol, interval, isTestnet, product, limit);
  } else if (exchange === 'bybit') {
    return fetchBybitKlines(symbol, interval, isTestnet, limit);
  }
  return [];
}


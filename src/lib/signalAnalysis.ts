import type { Candle } from './marketData.js';
import { calculateEMA, calculateRSI, calculateMACD, calculateAverageVolume } from './indicators.js';

export interface Signal {
  action: 'buy' | 'sell' | 'none';
  symbol: string;
  price: number;
  confidence: number;
  indicators: {
    ema_trend: 'bullish' | 'bearish' | 'neutral';
    rsi_signal: 'oversold' | 'overbought' | 'neutral';
    macd_signal: 'bullish' | 'bearish' | 'neutral';
    volume_confirmed: boolean;
  };
  rsi_value: number;
  current_volume: number;
  average_volume: number;
}

export interface StrategyIndicators {
  ema_short: number;
  ema_long: number;
  rsi_period: number;
  rsi_overbought: number;
  rsi_oversold: number;
  macd_fast: number;
  macd_slow: number;
  macd_signal: number;
  volume_multiplier: number;
}

interface MarketConditions {
  isTrending: boolean;
  trendStrength: number;
  volatility: number;
  priceChange: number;
}

function analyzeMarketConditions(candles: Candle[]): MarketConditions {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  
  const currentPrice = closes[closes.length - 1];
  const price20CandlesAgo = closes[closes.length - 20] || currentPrice;
  const price50CandlesAgo = closes[closes.length - 50] || currentPrice;
  
  // Calculate price change over 20 and 50 candles
  const priceChange20 = ((currentPrice - price20CandlesAgo) / price20CandlesAgo) * 100;
  const priceChange50 = ((currentPrice - price50CandlesAgo) / price50CandlesAgo) * 100;
  
  // Calculate volatility (ATR-like calculation)
  const recentHighs = highs.slice(-20);
  const recentLows = lows.slice(-20);
  const avgRange = recentHighs.reduce((sum, high, i) => sum + (high - recentLows[i]), 0) / 20;
  const volatility = (avgRange / currentPrice) * 100;
  
  // Trend strength: How consistent is the price movement?
  const trendStrength = Math.abs(priceChange20) + Math.abs(priceChange50) / 2;
  
  // Market is trending if price moved > 0.5% in 20 candles and trend is consistent (ADJUSTED for more signals)
  const isTrending = Math.abs(priceChange20) > 0.5 && Math.sign(priceChange20) === Math.sign(priceChange50);
  
  return {
    isTrending,
    trendStrength,
    volatility,
    priceChange: priceChange20,
  };
}

export function analyzeSignal(candles: Candle[], indicators: StrategyIndicators, symbol: string): Signal {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  
  // Use last candle's close price as signal price
  // For more accurate execution, could use (bid+ask)/2 from order book, but close is standard
  const currentPrice = closes[closes.length - 1];
  const currentVolume = volumes[volumes.length - 1];
  const averageVolume = calculateAverageVolume(volumes, 20);
  
  // Log price source for debugging
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[signalAnalysis] ${symbol}: Price from last candle close = ${currentPrice}, High=${highs[highs.length - 1]}, Low=${lows[lows.length - 1]}`);
  }
  
  // Analyze market conditions
  const marketConditions = analyzeMarketConditions(candles);
  
  // EMA Analysis
  const emaShort = calculateEMA(closes, indicators.ema_short);
  const emaLong = calculateEMA(closes, indicators.ema_long);
  
  if (emaShort.length < 2 || emaLong.length < 2) {
    return {
      action: 'none',
      symbol,
      price: currentPrice,
      confidence: 0,
      indicators: {
        ema_trend: 'neutral',
        rsi_signal: 'neutral',
        macd_signal: 'neutral',
        volume_confirmed: false,
      },
      rsi_value: 50,
      current_volume: currentVolume,
      average_volume: averageVolume,
    };
  }
  
  const currentEmaShort = emaShort[emaShort.length - 1];
  const previousEmaShort = emaShort[emaShort.length - 2];
  const currentEmaLong = emaLong[emaLong.length - 1];
  const previousEmaLong = emaLong[emaLong.length - 2];
  
  // EMA Crossover detection
  let ema_trend: Signal['indicators']['ema_trend'] = 'neutral';
  if (previousEmaShort < previousEmaLong && currentEmaShort > currentEmaLong) {
    ema_trend = 'bullish'; // Golden cross
  } else if (previousEmaShort > previousEmaLong && currentEmaShort < currentEmaLong) {
    ema_trend = 'bearish'; // Death cross
  } else if (currentEmaShort > currentEmaLong) {
    ema_trend = 'bullish';
  } else if (currentEmaShort < currentEmaLong) {
    ema_trend = 'bearish';
  }
  
  // RSI Analysis - MORE SENSITIVE for earlier signals
  const rsiValues = calculateRSI(closes, indicators.rsi_period);
  const currentRSI = rsiValues[rsiValues.length - 1] ?? 50;
  
  // Adjusted thresholds: overbought at 65 (was 70), oversold at 35 (was 30)
  const rsiOverbought = indicators.rsi_overbought >= 70 ? 65 : indicators.rsi_overbought;
  const rsiOversold = indicators.rsi_oversold <= 30 ? 35 : indicators.rsi_oversold;
  
  let rsi_signal: Signal['indicators']['rsi_signal'] = 'neutral';
  if (currentRSI < rsiOversold) {
    rsi_signal = 'oversold';
  } else if (currentRSI > rsiOverbought) {
    rsi_signal = 'overbought';
  }
  
  // MACD Analysis
  const macdResult = calculateMACD(closes, indicators.macd_fast, indicators.macd_slow, indicators.macd_signal);
  const currentHistogram = macdResult.histogram[macdResult.histogram.length - 1] ?? 0;
  const previousHistogram = macdResult.histogram[macdResult.histogram.length - 2] ?? 0;
  
  let macd_signal: Signal['indicators']['macd_signal'] = 'neutral';
  if (previousHistogram < 0 && currentHistogram > 0) {
    macd_signal = 'bullish'; // MACD crossing above signal
  } else if (previousHistogram > 0 && currentHistogram < 0) {
    macd_signal = 'bearish'; // MACD crossing below signal
  } else if (currentHistogram > 0) {
    macd_signal = 'bullish';
  } else if (currentHistogram < 0) {
    macd_signal = 'bearish';
  }
  
  // Volume confirmation - OPTIMIZED: Balanced threshold for reliable signals
  const volumeMultiplier = indicators.volume_multiplier >= 1.2 ? Math.max(1.5, indicators.volume_multiplier) : 1.5;
  const volume_confirmed = currentVolume > averageVolume * volumeMultiplier;
  
  // Multi-indicator signal generation
  let action: Signal['action'] = 'none';
  let confidence = 0;
  
  // BUY Signal: EMA bullish + RSI oversold/neutral + MACD bullish + Volume confirmed
  const bullishCount = [
    ema_trend === 'bullish',
    rsi_signal === 'oversold' || (rsi_signal === 'neutral' && ema_trend === 'bullish'),
    macd_signal === 'bullish',
    volume_confirmed,
  ].filter(Boolean).length;
  
  // SELL Signal: EMA bearish + RSI overbought/neutral + MACD bearish + Volume confirmed
  const bearishCount = [
    ema_trend === 'bearish',
    rsi_signal === 'overbought' || (rsi_signal === 'neutral' && ema_trend === 'bearish'),
    macd_signal === 'bearish',
    volume_confirmed,
  ].filter(Boolean).length;
  
  // Debug logging for signal analysis
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[signalAnalysis] ${symbol} indicator counts: bullish=${bullishCount}, bearish=${bearishCount}`);
    console.log(`[signalAnalysis] ${symbol} market conditions: trending=${marketConditions.isTrending}, volatility=${marketConditions.volatility.toFixed(2)}%`);
  }
  
  // Need at least 2 confirmations (50%) for more frequent signals (ADJUSTED from 3)
  // This allows more signals while still requiring multiple confirmations
  if (bullishCount >= 2) {
    action = 'buy';
    confidence = bullishCount / 4;
  } else if (bearishCount >= 2) {
    action = 'sell';
    confidence = bearishCount / 4;
  }
  
  // OPTIMIZED: Market condition filter - Skip choppy/sideways markets
  // Only trade in trending markets for better win rate
  if (action !== 'none' && !marketConditions.isTrending) {
    // If market is not trending, require all 4 indicators to confirm
    if (bullishCount < 4 && bearishCount < 4) {
      action = 'none';
      confidence = 0;
    }
  }
  
  // OPTIMIZED: Volatility filter - Skip extremely volatile markets (ADJUSTED threshold to 8%)
  // High volatility (>8%) increases risk of false signals
  if (action !== 'none' && marketConditions.volatility > 8.0) {
    // Require all 4 indicators in high volatility
    if (bullishCount < 4 && bearishCount < 4) {
      action = 'none';
      confidence = 0;
    }
  }
  
  // Boost confidence if market conditions are favorable
  if (action !== 'none' && marketConditions.isTrending && marketConditions.volatility < 3.0) {
    confidence = Math.min(1.0, confidence * 1.1); // 10% boost for ideal conditions
  }
  
  return {
    action,
    symbol,
    price: currentPrice,
    confidence,
    indicators: {
      ema_trend,
      rsi_signal,
      macd_signal,
      volume_confirmed,
    },
    rsi_value: currentRSI,
    current_volume: currentVolume,
    average_volume: averageVolume,
  };
}


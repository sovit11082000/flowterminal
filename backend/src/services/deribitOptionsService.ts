export type OptionBase = 'BTC' | 'ETH';

export interface StrikeGexInfo {
  strike: number;
  callGex: number;
  putGex: number;
  netGex: number;
  callOi: number;
  putOi: number;
}

export interface DeribitGammaSnapshot {
  baseCoin: OptionBase;
  spotPrice: number;
  totalCallGexUsd: number;
  totalPutGexUsd: number;
  netGexUsd: number;
  regime: 'POSITIVE_GAMMA' | 'NEGATIVE_GAMMA';
  callWall: number | null; // Strike with max Call GEX (Dealer Sell Wall / Pin)
  putWall: number | null;  // Strike with max Put GEX (Dealer Buy Wall / Floor)
  gammaFlip: number | null; // Strike nearest spot where Net GEX crosses 0
  callOpenInterest: number;
  putOpenInterest: number;
  pcrRatio: number;
  summary: string;
  topStrikes: StrikeGexInfo[];
  updatedAt: number;
}

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function calcGamma(S: number, K: number, T: number, sigma: number): number {
  if (T <= 0.0001 || sigma <= 0 || S <= 0 || K <= 0) return 0;
  const vsqrt = sigma * Math.sqrt(T);
  if (!Number.isFinite(vsqrt) || vsqrt <= 0) return 0;
  const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / vsqrt;
  const g = normPdf(d1) / (S * vsqrt);
  return Number.isFinite(g) ? g : 0;
}

const MONTH_MAP: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
};

export class DeribitOptionsService {
  private cache = new Map<OptionBase, DeribitGammaSnapshot>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly baseUrl: string;

  constructor(baseUrl = 'https://www.deribit.com') {
    this.baseUrl = baseUrl;
  }

  async fetchSnapshot(baseCoin: OptionBase): Promise<DeribitGammaSnapshot> {
    const url = `${this.baseUrl}/api/v2/public/get_book_summary_by_currency?currency=${baseCoin}&kind=option`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000)
    });

    if (!response.ok) {
      throw new Error(`Deribit options request failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      result?: Array<{
        instrument_name: string;
        underlying_price?: number;
        open_interest?: number;
        mark_iv?: number;
      }>;
    };

    const items = payload.result ?? [];
    if (items.length === 0) {
      throw new Error(`Deribit returned 0 options for ${baseCoin}`);
    }

    const now = Date.now();
    let spot = 0;
    for (const it of items) {
      if (typeof it.underlying_price === 'number' && it.underlying_price > 0) {
        spot = it.underlying_price;
        break;
      }
    }
    if (spot <= 0) {
      const cached = this.cache.get(baseCoin);
      if (cached) return cached;
      throw new Error(`No underlying spot price found in Deribit options for ${baseCoin}`);
    }

    const strikesGex: Record<number, StrikeGexInfo> = {};
    let totalCallGex = 0;
    let totalPutGex = 0;
    let totalCallOi = 0;
    let totalPutOi = 0;

    for (const it of items) {
      const parts = it.instrument_name.split('-');
      if (parts.length < 4) continue;

      const dateMatch = parts[1].match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
      if (!dateMatch) continue;

      const strike = parseFloat(parts[2]);
      const type = parts[3]; // 'C' or 'P'
      const oi = Number(it.open_interest) || 0;
      const iv = (Number(it.mark_iv) || 0) / 100;
      if (oi <= 0 || iv <= 0 || !Number.isFinite(strike) || strike <= 0) continue;

      const day = parseInt(dateMatch[1], 10);
      const mon = MONTH_MAP[dateMatch[2]];
      const yr = 2000 + parseInt(dateMatch[3], 10);
      if (mon === undefined || Number.isNaN(day) || Number.isNaN(yr)) continue;

      const expDate = Date.UTC(yr, mon, day, 8, 0, 0);
      const T = (expDate - now) / (1000 * 86400 * 365.25);
      if (T <= 0.0001 || T > 1.5) continue; // Focus on active contracts within 1.5 years

      const gamma = calcGamma(spot, strike, T, iv);
      // Dollar Gamma per 1% move: Gamma * OI * Spot^2 * 0.01
      const dollarGex = gamma * oi * (spot * spot) * 0.01;
      if (!Number.isFinite(dollarGex)) continue;

      if (!strikesGex[strike]) {
        strikesGex[strike] = { strike, callGex: 0, putGex: 0, netGex: 0, callOi: 0, putOi: 0 };
      }

      if (type === 'C') {
        strikesGex[strike].callGex += dollarGex;
        strikesGex[strike].callOi += oi;
        totalCallGex += dollarGex;
        totalCallOi += oi;
      } else if (type === 'P') {
        strikesGex[strike].putGex += dollarGex;
        strikesGex[strike].putOi += oi;
        totalPutGex += dollarGex;
        totalPutOi += oi;
      }
      strikesGex[strike].netGex = strikesGex[strike].callGex - strikesGex[strike].putGex;
    }

    const netGex = totalCallGex - totalPutGex;
    const sortedStrikes = Object.values(strikesGex).sort((a, b) => a.strike - b.strike);

    let callWall: number | null = null;
    let maxCallGex = 0;
    let putWall: number | null = null;
    let maxPutGex = 0;

    for (const s of sortedStrikes) {
      if (s.callGex > maxCallGex) {
        maxCallGex = s.callGex;
        callWall = s.strike;
      }
      if (s.putGex > maxPutGex) {
        maxPutGex = s.putGex;
        putWall = s.strike;
      }
    }

    // Gamma flip estimation: strike nearest spot where netGex changes sign
    let gammaFlip: number | null = null;
    let minFlipDiff = Infinity;
    for (let i = 0; i < sortedStrikes.length - 1; i++) {
      const s1 = sortedStrikes[i];
      const s2 = sortedStrikes[i + 1];
      if ((s1.netGex <= 0 && s2.netGex > 0) || (s1.netGex >= 0 && s2.netGex < 0)) {
        const diff = Math.abs(s1.strike - spot);
        if (diff < minFlipDiff && diff < spot * 0.25) {
          minFlipDiff = diff;
          gammaFlip = s1.strike;
        }
      }
    }

    const regime = netGex >= 0 ? 'POSITIVE_GAMMA' : 'NEGATIVE_GAMMA';
    const netGexM = (netGex / 1e6).toFixed(1);
    const pcrRatio = Number((totalPutOi / Math.max(totalCallOi, 1)).toFixed(2));

    const summary = `${baseCoin} ${regime} ($${netGexM}M Net GEX). Call Wall: $${callWall ?? 'N/A'}, Put Wall: $${putWall ?? 'N/A'}, Gamma Flip: $${gammaFlip ?? 'N/A'}, PCR: ${pcrRatio}`;

    // Get top 10 strikes by total GEX for detail
    const topStrikes = [...sortedStrikes]
      .sort((a, b) => (b.callGex + b.putGex) - (a.callGex + a.putGex))
      .slice(0, 10);

    const snapshot: DeribitGammaSnapshot = {
      baseCoin,
      spotPrice: spot,
      totalCallGexUsd: Math.round(totalCallGex),
      totalPutGexUsd: Math.round(totalPutGex),
      netGexUsd: Math.round(netGex),
      regime,
      callWall,
      putWall,
      gammaFlip,
      callOpenInterest: Math.round(totalCallOi),
      putOpenInterest: Math.round(totalPutOi),
      pcrRatio,
      summary,
      topStrikes,
      updatedAt: now
    };

    this.cache.set(baseCoin, snapshot);
    return snapshot;
  }

  getLatestSnapshot(baseCoin: OptionBase): DeribitGammaSnapshot | null {
    return this.cache.get(baseCoin) ?? null;
  }

  startAutoRefresh(intervalMs = 300_000): void {
    const refresh = async () => {
      for (const coin of ['BTC', 'ETH'] as OptionBase[]) {
        try {
          await this.fetchSnapshot(coin);
        } catch (err: unknown) {
          console.warn(`[Deribit Gamma] Failed to refresh ${coin} options:`, err instanceof Error ? err.message : String(err));
        }
      }
    };

    // Initial immediate background fetch
    void refresh();
    this.refreshTimer = setInterval(refresh, intervalMs);
    if (this.refreshTimer.unref) this.refreshTimer.unref();
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}

import { SPECIALIST_AGENTS, ORDER_FLOW_SKILL } from './orderFlowSkill.js';
import { createHash } from 'node:crypto';

export interface AgentSnapshot {
  symbol: string;
  timeframe: '1m' | '5m';
  feedStatus: string;
  lastTradeAt: number | null;
  latestPrice: number | null;
  profile?: { poc: number; vah: number; val: number; capturedBars: number } | null;
  technicalContext?: {
    smc: { bias: string; events: Array<{ type: string; time: number; price: number; bullish: boolean }>; zones: Array<{ kind: string; startTime: number; endTime: number; top: number; bottom: number; bullish: boolean }>; liquidity: Array<{ label: string; time: number; price: number; swept: boolean }> };
    ict: { po3: Array<{ label: string; time: number; endTime: number; top: number; bottom: number; bullish?: boolean }>; dailyRanges: Array<{ day: number; high: number; low: number }> };
  };
  candles: Array<{ time: number; high: number; low: number; close: number }>;
  footprints: Array<{
    time: number; open: number; high: number; low: number; close: number;
    totalVolume: number; buyVolume: number; sellVolume: number; delta: number;
    cumulativeDelta: number; pocPrice: number; isClosed: boolean;
    priceLevels: Array<{ price: number; bidVolume: number; askVolume: number; totalVolume: number }>;
  }>;
  trades: Array<{ timestamp: number; side: string; price: number; size: number }>;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  paperPerformance?: {
    resolved: number; wins: number; losses: number; expired: number;
    winRate: number | null; averageR: number | null;
    recent: Array<{ side: 'LONG' | 'SHORT'; outcome: 'WIN' | 'LOSS'; pnlR: number }>;
  } | null;
}

type AiProvider = 'gemini' | 'groq' | 'ollama';
type AgentRole = 'smc' | 'ict' | 'orderflow' | 'manager';
interface ProviderConfig { provider: AiProvider; model: string; key?: string; baseUrl?: string; quotaScope?: string; }

interface UsageWindow { day: string; daily: number; minute: number; minuteCount: number; cooldownUntil: number; }
const requestUsage = new Map<string, UsageWindow>();
const modelRotors = new Map<string, number>();

function pacificDay(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function quotaKey(config: ProviderConfig): string {
  if (config.quotaScope) return `${config.provider}:${config.quotaScope}:${config.model}`;
  const identity = config.key || config.baseUrl || config.model;
  return `${config.provider}:${createHash('sha256').update(identity).digest('hex')}`;
}

function quotaFor(config: ProviderConfig): { rpm: number; rpd: number } {
  if (config.provider !== 'gemini') return { rpm: 0, rpd: 0 };
  const overrideRpm = Number(process.env.GEMINI_REQUESTS_PER_MINUTE_PER_PROJECT || 0);
  const overrideRpd = Number(process.env.GEMINI_REQUESTS_PER_DAY_PER_PROJECT || 0);
  const model = config.model.toLowerCase();
  const defaults = model.includes('flash-lite')
    ? { rpm: 14, rpd: 475 }
    : model.includes('3.8-flash') || model.includes('3.6-flash') || model.includes('3.5-flash') || model.includes('3-flash')
      ? { rpm: 4, rpd: 19 }
      : { rpm: 0, rpd: 0 };
  return { rpm: overrideRpm > 0 ? overrideRpm : defaults.rpm, rpd: overrideRpd > 0 ? overrideRpd : defaults.rpd };
}

function usageFor(config: ProviderConfig): UsageWindow {
  const id = quotaKey(config);
  const today = pacificDay();
  const existing = requestUsage.get(id);
  if (!existing || existing.day !== today) {
    const fresh = { day: today, daily: 0, minute: Math.floor(Date.now() / 60_000), minuteCount: 0, cooldownUntil: 0 };
    requestUsage.set(id, fresh);
    return fresh;
  }
  const currentMinute = Math.floor(Date.now() / 60_000);
  if (existing.minute !== currentMinute) { existing.minute = currentMinute; existing.minuteCount = 0; }
  return existing;
}

function isAvailable(config: ProviderConfig): boolean {
  const usage = usageFor(config);
  const quota = quotaFor(config);
  return Date.now() >= usage.cooldownUntil &&
    (!quota.rpm || usage.minuteCount < quota.rpm) &&
    (!quota.rpd || usage.daily < quota.rpd);
}

function recordAttempt(config: ProviderConfig): void {
  const usage = usageFor(config);
  usage.daily += 1;
  usage.minuteCount += 1;
}

export interface SpecialistReport {
  agentId: string;
  name: string;
  bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  strength: number;
  findings: string[];
  concerns: string[];
  missingData: string[];
}

export interface CouncilPlan {
  decision: 'LONG' | 'SHORT' | 'WAIT';
  summary: string;
  entryTrigger: string;
  entryPrice: number | null;
  invalidation: string;
  stopPrice: number | null;
  targetPrice: number | null;
  targetR: 2 | 3 | null;
  exitPlan: string;
  agreeingAgents: string[];
  dissent: string[];
}

export interface CouncilResult { reports: SpecialistReport[]; plan: CouncilPlan; model: string; generatedAt: number; }

const reportSchema = {
  type: 'OBJECT',
  properties: {
    bias: { type: 'STRING', enum: ['LONG', 'SHORT', 'NEUTRAL'] },
    strength: { type: 'INTEGER' },
    findings: { type: 'ARRAY', items: { type: 'STRING' } },
    concerns: { type: 'ARRAY', items: { type: 'STRING' } },
    missingData: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['bias', 'strength', 'findings', 'concerns', 'missingData']
};

const planSchema = {
  type: 'OBJECT',
  properties: {
    decision: { type: 'STRING', enum: ['LONG', 'SHORT', 'WAIT'] },
    summary: { type: 'STRING' },
    entryTrigger: { type: 'STRING' },
    entryPrice: { type: 'NUMBER', nullable: true },
    invalidation: { type: 'STRING' },
    stopPrice: { type: 'NUMBER', nullable: true },
    targetPrice: { type: 'NUMBER', nullable: true },
    targetR: { type: 'INTEGER', nullable: true },
    exitPlan: { type: 'STRING' },
    agreeingAgents: { type: 'ARRAY', items: { type: 'STRING' } },
    dissent: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['decision', 'summary', 'entryTrigger', 'entryPrice', 'invalidation', 'stopPrice', 'targetPrice', 'targetR', 'exitPlan', 'agreeingAgents', 'dissent']
};

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 5).map((item) => item.slice(0, 220)) : [];
}

function parseObject<T>(text: string): T {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI provider returned an invalid structured response.');
  return parsed as T;
}

function extractGeminiText(payload: unknown): string {
  const root = payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = root.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim();
  if (!text) throw new Error('Gemini returned an empty response.');
  return text;
}

function compactSnapshot(snapshot: AgentSnapshot): AgentSnapshot {
  return {
    ...snapshot,
    candles: snapshot.candles.slice(-200),
    footprints: snapshot.footprints.filter((bar) => bar.isClosed).slice(-6).map((bar) => ({
      ...bar,
      priceLevels: [...bar.priceLevels].sort((a, b) => Math.abs(a.price - bar.pocPrice) - Math.abs(b.price - bar.pocPrice)).slice(0, 24)
    })),
    trades: snapshot.trades.slice(0, 20),
    bids: snapshot.bids.slice(0, 10),
    asks: snapshot.asks.slice(0, 10)
  };
}

async function generateJson<T>(config: ProviderConfig, system: string, input: unknown, schema: object): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.provider === 'ollama' ? 90_000 : 35_000);
  try {
    const url = config.provider === 'gemini'
      ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`
      : config.provider === 'groq'
        ? `${config.baseUrl ?? 'https://api.groq.com/openai/v1'}/chat/completions`
        : `${config.baseUrl ?? 'http://127.0.0.1:11434'}/api/chat`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (config.provider === 'gemini' && config.key) headers['x-goog-api-key'] = config.key;
    if (config.provider === 'groq' && config.key) headers.Authorization = `Bearer ${config.key}`;
    const body = config.provider === 'gemini'
      ? {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
          generationConfig: { temperature: 0.15, maxOutputTokens: 900, responseMimeType: 'application/json', responseSchema: schema }
        }
      : config.provider === 'groq'
        ? {
            model: config.model, temperature: 0.15, max_completion_tokens: 900,
            response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }]
          }
        : {
            model: config.model, stream: false, format: schema,
            messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }],
            options: { temperature: 0.15 }
          };
    recordAttempt(config);
    const response = await fetch(url, { method: 'POST', headers, signal: controller.signal, body: JSON.stringify(body) });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      usageFor(config).cooldownUntil = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000);
      throw new Error(`${config.provider} quota or rate limit reached.`);
    }
    if (!response.ok) {
      const status = response.status;
      if (status === 400 || status === 403) throw new Error(`${config.provider} rejected the request. Check its API key, model, and provider configuration.`);
      if (config.provider === 'ollama' && status === 404) throw new Error(`Ollama model "${config.model}" was not found. Pull that model first and retry.`);
      throw new Error(`${config.provider} request failed with HTTP ${status}.`);
    }
    const payload = await response.json() as any;
    const text = config.provider === 'gemini'
      ? extractGeminiText(payload)
      : config.provider === 'groq'
        ? payload.choices?.[0]?.message?.content
        : payload.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error(`${config.provider} returned an empty structured response.`);
    return parseObject<T>(text.trim());
  } finally {
    clearTimeout(timer);
  }
}

async function generateWithFallback<T>(providers: ProviderConfig[], role: AgentRole, system: string, input: unknown, schema: object): Promise<T> {
  const failures: string[] = [];
  const eligible = providers.filter(isAvailable);
  if (!eligible.length) throw new Error(`All configured credentials for ${role} are at their configured Gemini quota budget or cooldown. Wait for quota reset or add another authorized project credential.`);
  const rotorId = `${role}:${eligible.map(quotaKey).join(',')}`;
  const startAt = (modelRotors.get(rotorId) ?? 0) % eligible.length;
  const ordered = [...eligible.slice(startAt), ...eligible.slice(0, startAt)];
  for (const provider of ordered) {
    try { return await generateJson<T>(provider, system, input, schema); }
    catch (error) { failures.push(error instanceof Error ? `${provider.provider}: ${error.message}` : `${provider.provider}: request failed`); }
  }
  modelRotors.set(rotorId, (startAt + 1) % eligible.length);
  throw new Error(`All configured AI providers failed. ${failures.join(' | ')}`);
}

function parseGeminiCredentials(raw: string | undefined, model: string): ProviderConfig[] {
  if (!raw?.trim()) return [];
  return raw.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf('|');
    const project = separator >= 0 ? part.slice(0, separator).trim() : '';
    const key = separator >= 0 ? part.slice(separator + 1).trim() : part;
    return key ? { provider: 'gemini' as const, key, model, quotaScope: project || undefined } : null;
  }).filter((item): item is ProviderConfig => item !== null);
}

function getProviderConfigs(role: AgentRole): ProviderConfig[] {
  const mode = (process.env.ORDERFLOW_AI_MODE?.trim().toLowerCase() || 'ensemble') as AiProvider | 'ensemble';
  const configured: ProviderConfig[] = [];
  const roleName = role.toUpperCase();
  const specialistModel = process.env.GEMINI_SPECIALIST_MODEL?.trim() || 'gemini-3.5-flash-lite';
  const roleModel = process.env[`GEMINI_${roleName}_MODEL`]?.trim();
  const model = roleModel || (role === 'manager' ? process.env.GEMINI_MANAGER_MODEL?.trim() || 'gemini-3.8-flash' : specialistModel);
  configured.push(...parseGeminiCredentials(process.env[`GEMINI_${roleName}_CREDENTIALS`], model));
  const legacyKey = process.env.GEMINI_API_KEY?.trim();
  if (!configured.some((item) => item.provider === 'gemini') && legacyKey) {
    configured.push({ provider: 'gemini', key: legacyKey, model: process.env.GEMINI_MODEL?.trim() || model });
  }
  const groqKey = process.env.GROQ_API_KEY?.trim();
  if (groqKey) configured.push({ provider: 'groq', key: groqKey, model: process.env.GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile' });
  const ollamaModel = process.env.OLLAMA_MODEL?.trim();
  if (ollamaModel && mode !== 'gemini') configured.push({ provider: 'ollama', model: ollamaModel, baseUrl: (process.env.OLLAMA_BASE_URL?.trim() || 'http://127.0.0.1:11434').replace(/\/$/, '') });
  if (mode === 'ensemble') return configured;
  return configured.filter((config) => config.provider === mode);
}

function sanitizeReport(value: SpecialistReport, agent: typeof SPECIALIST_AGENTS[number]): SpecialistReport {
  return {
    agentId: agent.id,
    name: agent.name,
    bias: value.bias === 'LONG' || value.bias === 'SHORT' ? value.bias : 'NEUTRAL',
    strength: Math.max(0, Math.min(3, Math.round(Number(value.strength) || 0))),
    findings: textList(value.findings),
    concerns: textList(value.concerns),
    missingData: textList(value.missingData)
  };
}

function sanitizePlan(value: CouncilPlan, reports: SpecialistReport[], snapshot: AgentSnapshot): CouncilPlan {
  let decision: CouncilPlan['decision'] = value.decision === 'LONG' || value.decision === 'SHORT' ? value.decision : 'WAIT';
  const aligned = reports.filter((report) => report.bias === decision && report.strength >= 2);
  const unanimous = reports.length === SPECIALIST_AGENTS.length &&
    (decision === 'LONG' || decision === 'SHORT') && reports.every((report) => report.bias === decision && report.strength >= 2);
  const firstBias = reports[0]?.bias;
  const consensusBias = reports.length === SPECIALIST_AGENTS.length &&
    (firstBias === 'LONG' || firstBias === 'SHORT') && reports.every((report) => report.bias === firstBias && report.strength >= 2)
    ? firstBias : null;
  const hasFreshFeed = snapshot.feedStatus === 'LIVE' &&
    snapshot.lastTradeAt !== null && Date.now() - snapshot.lastTradeAt < 15_000;
  const hasContext = snapshot.footprints.filter((bar) => bar.isClosed).length >= 4 && snapshot.candles.length >= 4;
  const entryPrice = Number(value.entryPrice);
  const stopPrice = Number(value.stopPrice);
  const targetPrice = Number(value.targetPrice);
  const targetR = value.targetR === 2 || value.targetR === 3 ? value.targetR : null;
  const risk = Math.abs(entryPrice - stopPrice);
  const reward = Math.abs(targetPrice - entryPrice);
  const actualR = risk > 0 ? reward / risk : 0;
  const trigger = String(value.entryTrigger ?? '').trim();
  const invalidation = String(value.invalidation ?? '').trim();
  const exitPlan = String(value.exitPlan ?? '').trim();
  const hasPocOrValueAreaTrigger = /\b(poc|value\s*area|vah|val)\b/i.test(trigger) && /pullback|retest|reclaim|reject|hold/i.test(trigger);
  const validLevels = Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(stopPrice) && stopPrice > 0 &&
    Number.isFinite(targetPrice) && targetPrice > 0 && targetR !== null && risk > 0 &&
    Math.abs(actualR - targetR) <= 0.25 &&
    (decision === 'LONG' ? stopPrice < entryPrice && targetPrice > entryPrice : decision === 'SHORT' ? stopPrice > entryPrice && targetPrice < entryPrice : false);
  const opposingLiquidity = snapshot.technicalContext?.smc.liquidity
    .filter((level) => !level.swept && Number.isFinite(level.price) &&
      (decision === 'LONG' ? level.price > entryPrice : level.price < entryPrice))
    .sort((a, b) => Math.abs(a.price - entryPrice) - Math.abs(b.price - entryPrice))[0];
  const targetBeforeOpposingLiquidity = !!opposingLiquidity &&
    (decision === 'LONG' ? targetPrice < opposingLiquidity.price : targetPrice > opposingLiquidity.price);
  // A directional plan is allowed only with unanimous specialist agreement,
  // fresh evidence, a POC/VA pullback trigger and valid structural risk levels.
  if (decision !== 'WAIT' && (!unanimous || !hasFreshFeed || !hasContext || !hasPocOrValueAreaTrigger ||
    !validLevels || !targetBeforeOpposingLiquidity || !invalidation || !exitPlan)) decision = 'WAIT';
  return {
    decision,
    summary: String(value.summary ?? 'Insufficient agreement; wait.').slice(0, 420),
    entryTrigger: decision === 'WAIT' ? 'WAIT: no entry until unanimous confirmation and a valid POC/VA pullback trigger.' : trigger.slice(0, 260),
    entryPrice: decision === 'WAIT' ? null : entryPrice,
    invalidation: decision === 'WAIT' ? 'WAIT: no active structural invalidation level.' : invalidation.slice(0, 260),
    stopPrice: decision === 'WAIT' ? null : stopPrice,
    targetPrice: decision === 'WAIT' ? null : targetPrice,
    targetR: decision === 'WAIT' ? null : targetR,
    exitPlan: decision === 'WAIT' ? 'WAIT: reassess after the trigger, closed-bar confirmation, or invalidation.' : exitPlan.slice(0, 260),
    agreeingAgents: decision === 'WAIT' ? [] : aligned.map((report) => report.name),
    dissent: reports.filter((report) => !consensusBias || report.bias !== consensusBias || report.strength < 2)
      .map((report) => `${report.name}: ${report.bias} (strength ${report.strength})`)
  };
}

export async function runOrderFlowCouncil(snapshot: AgentSnapshot): Promise<CouncilResult> {
  const configuredRoles = SPECIALIST_AGENTS.map((agent) => getProviderConfigs(agent.id));
  const managerProviders = getProviderConfigs('manager');
  const providers = [...configuredRoles.flat(), ...managerProviders];
  if (!providers.length) throw new Error('No AI provider is configured. Set GEMINI_API_KEY, GROQ_API_KEY, and/or OLLAMA_MODEL in backend/.env, then restart the backend.');
  const input = compactSnapshot(snapshot);
  const missingRole = SPECIALIST_AGENTS.find((agent, index) => !configuredRoles[index].length);
  if (missingRole) throw new Error(`No AI credential is configured for ${missingRole.id}. Add GEMINI_${missingRole.id.toUpperCase()}_CREDENTIALS to backend/.env.`);
  // The three independent specialist reads run concurrently; manager starts only
  // after every read has settled and receives explicit NEUTRAL reports on failures.
  const reports = await Promise.all(SPECIALIST_AGENTS.map(async (agent, index) => {
    try {
      const raw = await generateWithFallback<SpecialistReport>(configuredRoles[index], agent.id,
        `${ORDER_FLOW_SKILL}\nROLE: ${agent.name}\nTASK: ${agent.focus}\nReturn bias LONG, SHORT, or NEUTRAL; strength 0-3; concrete findings, concerns, and missing data. Do not create an entry price or target.`,
        input, reportSchema);
      return sanitizeReport(raw, agent);
    } catch (error) {
      return {
        agentId: agent.id, name: agent.name, bias: 'NEUTRAL' as const, strength: 0,
        findings: [], concerns: [error instanceof Error ? error.message.slice(0, 220) : 'Specialist analysis failed.'],
        missingData: ['Specialist analysis unavailable; strict consensus cannot be formed.']
      };
    }
  }));

  if (!managerProviders.length) throw new Error('No AI credential is configured for the manager. Add GEMINI_MANAGER_CREDENTIALS to backend/.env.');
  const rawPlan = await generateWithFallback<CouncilPlan>(managerProviders, 'manager',
      `${ORDER_FLOW_SKILL}\nROLE: TRADE PLAN MANAGER\nReview the market snapshot and exactly three specialist reports. Return LONG/SHORT only if all three biases match and each strength is at least 2; any neutral, disagreement, failed specialist, stale feed, insufficient context, or missing level means WAIT. For a directional plan, specify an entry trigger as a conditional POC/VA pullback/retest, numeric entryPrice, structural invalidation text and numeric stopPrice, numeric targetPrice, targetR exactly 2 or 3 with target at that R multiple, and exitPlan. The target must sit before the nearest unswept opposing SMC liquidity level. Use supplied prices/levels only; if these constraints cannot be satisfied, return WAIT with null numeric levels.\n\nThe snapshot may contain paperPerformance from previously settled AI plans for the same symbol/timeframe. Use it only as cautious calibration: a sample under 20 resolved plans is too small to adjust the strategy; never claim a strategy is learned or profitable. If there are at least 20 resolved plans and performance is poor, require stronger confluence or choose WAIT; do not change price facts or relax the risk rules.\n\nThis is a paper/research suggestion only, never an exchange order.`,
    { snapshot: input, reports }, planSchema);
  const usedProviders = [...new Set([...configuredRoles.flat(), ...managerProviders].map((provider) => `${provider.provider}:${provider.model}`))].join(', ');
  return { reports, plan: sanitizePlan(rawPlan, reports, snapshot), model: usedProviders, generatedAt: Date.now() };
}

// Native DashboardService JSON shapes, with synthetic balances and no account identifiers.
import type { CursorReadings } from '../src/cursor-quota.ts';

export function cursorMonthly(now = Date.now()): CursorReadings {
  return {
    usage: { enabled: true, billingCycleStart: String(now - 86400000), billingCycleEnd: String(now + 86400000),
      planUsage: { totalSpend: 20000, limit: 1000, bonusSpend: 19000, autoPercentUsed: 53.125, apiPercentUsed: 100, totalPercentUsed: 60 }, spendLimitUsage: { limitType: 'user' } },
    plan: { planInfo: { includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_MONTHLY', billingCycleEnd: String(now + 86400000) } },
    credits: {}, onDemand: {}, policy: {},
  };
}

export function cursorWeekly(now = Date.now()): CursorReadings {
  return { ...cursorMonthly(now), plan: { isMerged: true, planInfo: { includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_WEEKLY' } },
    weekly: { currentPeriodStartMs: String(now - 86400000), currentPeriodEndMs: String(now + 6 * 86400000), usagePercent: 25, prepaidBalanceCents: '1234', prepaidBalanceWithheld: false },
  };
}

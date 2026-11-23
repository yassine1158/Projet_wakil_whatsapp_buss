import type { Plan, Subscription, Tenant } from "./types";

export const TRIAL_DAYS = 14;
const DAY_MS = 86_400_000;
/** Une période payée compte 30 jours. */
const MONTH_MS = 30 * DAY_MS;

/** none : entreprise créée par l'équipe Wakil, sans limite. */
export type SubscriptionStatus = "none" | "trial" | "active" | "expired";

export interface SubscriptionView {
  status: SubscriptionStatus;
  plan?: Plan;
  /** Fin de la période en cours (essai ou abonnement payé), ou de la dernière période pour un abonnement terminé. */
  endsAt?: number;
  daysLeft?: number;
}

export function subscriptionView(tenant: Tenant, now: number): SubscriptionView {
  const s = tenant.subscription;
  if (!s) return { status: "none" };
  const paid = s.paidUntil ?? 0, trial = s.trialEndsAt ?? 0;
  const status: SubscriptionStatus = paid > now ? "active" : trial > now ? "trial" : "expired";
  const endsAt = status === "active" ? paid : status === "trial" ? trial : Math.max(paid, trial) || undefined;
  return {
    status,
    plan: s.plan,
    ...(endsAt ? { endsAt } : {}),
    ...(status === "expired" ? {} : { daysLeft: Math.ceil((endsAt! - now) / DAY_MS) }),
  };
}

/** Faux quand l'essai ou l'abonnement est terminé : Wakil ne répond plus aux clients. */
export function isServing(tenant: Tenant, now: number): boolean {
  return subscriptionView(tenant, now).status !== "expired";
}

export function startTrial(plan: Plan, now: number): Subscription {
  return { plan, trialEndsAt: now + TRIAL_DAYS * DAY_MS };
}

/** Changements faits par l'administrateur : offre, jours d'essai en plus, mois payés. */
export function changeSubscription(
  current: Subscription,
  change: { plan?: Plan; trialDays?: number; paidMonths?: number },
  now: number,
): Subscription {
  const next = { ...current };
  if (change.plan) next.plan = change.plan;
  if (change.trialDays) next.trialEndsAt = Math.max(now, current.trialEndsAt ?? 0) + change.trialDays * DAY_MS;
  if (change.paidMonths) next.paidUntil = Math.max(now, current.paidUntil ?? 0) + change.paidMonths * MONTH_MS;
  return next;
}

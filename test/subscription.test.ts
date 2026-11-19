import { describe, expect, it } from "vitest";
import { changeSubscription, isServing, startTrial, subscriptionView } from "../src/subscription";
import type { Tenant } from "../src/types";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const tenant = (subscription?: Tenant["subscription"]) =>
  ({ id: "t", businessName: "T", assistantName: "Wakil", ownerPhone: "", timezone: "Africa/Abidjan", catalog: {}, subscription }) as Tenant;

describe("abonnement", () => {
  it("sans abonnement, Wakil répond sans limite", () => {
    expect(subscriptionView(tenant(), NOW)).toEqual({ status: "none" });
    expect(isServing(tenant(), NOW)).toBe(true);
  });

  it("essai, puis fin d'essai", () => {
    const t = tenant(startTrial("pro", NOW));
    expect(subscriptionView(t, NOW)).toEqual({ status: "trial", plan: "pro", endsAt: NOW + 14 * DAY, daysLeft: 14 });
    expect(subscriptionView(t, NOW + 13.5 * DAY).daysLeft).toBe(1);
    expect(subscriptionView(t, NOW + 14 * DAY)).toEqual({ status: "expired", plan: "pro", endsAt: NOW + 14 * DAY });
    expect(isServing(t, NOW + 14 * DAY)).toBe(false);
  });

  it("un mois payé s'ajoute à la période en cours, ou part d'aujourd'hui", () => {
    const paid = changeSubscription(startTrial("pro", NOW), { paidMonths: 1 }, NOW);
    expect(subscriptionView(tenant(paid), NOW)).toMatchObject({ status: "active", endsAt: NOW + 30 * DAY });
    const twice = changeSubscription(paid, { paidMonths: 1 }, NOW + 10 * DAY);
    expect(twice.paidUntil).toBe(NOW + 60 * DAY);
    const late = changeSubscription(paid, { paidMonths: 1 }, NOW + 40 * DAY);
    expect(late.paidUntil).toBe(NOW + 70 * DAY);
  });
});

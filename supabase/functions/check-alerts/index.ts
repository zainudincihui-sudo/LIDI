// check-alerts
//
// Scans active alert_rules and writes a row to alert_events for each
// condition that's newly true -- the frontend's bell panel then shows
// these as in-app notifications. Nothing sends email yet; that's a
// separate function landing in PR 5, deliberately kept apart so a Resend
// outage can't stop alert detection from working (same risk-isolation
// pattern as the sync-* functions each being their own Edge Function).
//
// Two condition types, handled independently:
//
// wallet_large_tx: fires once per (rule, transaction) pair -- a
// transaction on the rule's wallet with value_usd >= threshold, looked at
// within a window wider than the cron cadence (WALLET_TX_LOOKBACK_MINUTES)
// so a slow or delayed run can't let one fall through the gap between
// windows. Dedup is checked explicitly against existing alert_events
// before inserting (rather than relying on upsert/onConflict matching the
// migration's partial unique index), which keeps the logic easy to follow;
// that unique index is still there as a safety net against a genuine race
// between two overlapping invocations.
//
// price_change_pct: fires when a token's price_change_24h has moved past
// the rule's threshold in the rule's direction. There's no natural
// per-event key for this the way a transaction id is for wallet alerts --
// price_change_24h is a rolling figure that can stay past threshold for
// hours -- so it's cooldown-gated instead via alert_rules.last_triggered_at:
// a rule won't refire until PRICE_ALERT_COOLDOWN_HOURS has passed since it
// last fired. This is a simple v1 heuristic (a fixed cooldown rather than
// e.g. only firing on a *new* threshold crossing) and could be refined
// later.
//
// Triggered on a schedule via pg_cron (see supabase/migrations), and can
// also be invoked manually for testing:
//   supabase functions invoke check-alerts

import { createClient } from "jsr:@supabase/supabase-js@2";

const WALLET_TX_LOOKBACK_MINUTES = 15;
const PRICE_ALERT_COOLDOWN_HOURS = 6;

interface AlertRuleRow {
  id: string;
  user_id: string;
  wallet_id: string | null;
  token_id: string | null;
  condition_type: "wallet_large_tx" | "price_change_pct";
  direction: "up" | "down" | null;
  threshold: number;
  last_triggered_at: string | null;
}

interface WalletLike {
  label: string | null;
  address: string | null;
}

interface TokenLike {
  ticker: string | null;
  name: string | null;
}

interface TransactionRow {
  id: string;
  wallet_id: string;
  value_usd: number;
  occurred_at: string;
  wallets: WalletLike | null;
  tokens: TokenLike | null;
}

interface TokenPriceRow {
  id: string;
  ticker: string | null;
  name: string | null;
  price_change_24h: number | null;
}

function walletLabel(wallet: WalletLike | null): string {
  if (wallet?.label) return wallet.label;
  if (wallet?.address) {
    return wallet.address.length > 10
      ? `${wallet.address.slice(0, 4)}...${wallet.address.slice(-3)}`
      : wallet.address;
  }
  return "Wallet";
}

function tokenTicker(token: { ticker: string | null; name: string | null } | null): string {
  const raw = (token?.ticker || token?.name || "?").trim();
  return raw.startsWith("$") ? raw : `$${raw}`;
}

function formatUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

Deno.serve(async (_req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error(
        "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars (should be auto-provided by the Edge Functions runtime)",
      );
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data: rulesData, error: rulesError } = await supabase
      .from("alert_rules")
      .select("id, user_id, wallet_id, token_id, condition_type, direction, threshold, last_triggered_at")
      .eq("is_active", true);
    if (rulesError) throw new Error(`Failed to load alert_rules: ${rulesError.message}`);
    const rules = (rulesData || []) as AlertRuleRow[];

    const walletRules = rules.filter((r) => r.condition_type === "wallet_large_tx" && r.wallet_id);
    const priceRules = rules.filter((r) => r.condition_type === "price_change_pct" && r.token_id && r.direction);

    // ---- wallet_large_tx ----
    let walletEventsInserted = 0;
    const walletRuleIdsTriggered = new Set<string>();

    if (walletRules.length > 0) {
      const walletIds = Array.from(new Set(walletRules.map((r) => r.wallet_id as string)));
      const since = new Date(Date.now() - WALLET_TX_LOOKBACK_MINUTES * 60_000).toISOString();

      const { data: txData, error: txError } = await supabase
        .from("transactions")
        .select("id, wallet_id, value_usd, occurred_at, wallets(label, address), tokens(ticker, name)")
        .in("wallet_id", walletIds)
        .gte("occurred_at", since);
      if (txError) throw new Error(`Failed to load transactions: ${txError.message}`);
      const txs = (txData || []) as unknown as TransactionRow[];

      const txsByWallet = new Map<string, TransactionRow[]>();
      for (const tx of txs) {
        const list = txsByWallet.get(tx.wallet_id) || [];
        list.push(tx);
        txsByWallet.set(tx.wallet_id, list);
      }

      const candidates: { rule: AlertRuleRow; tx: TransactionRow }[] = [];
      for (const rule of walletRules) {
        for (const tx of txsByWallet.get(rule.wallet_id as string) || []) {
          if (Number(tx.value_usd) >= rule.threshold) {
            candidates.push({ rule, tx });
          }
        }
      }

      if (candidates.length > 0) {
        const candidateTxIds = Array.from(new Set(candidates.map((c) => c.tx.id)));
        const { data: existingData, error: existingError } = await supabase
          .from("alert_events")
          .select("alert_rule_id, trigger_transaction_id")
          .in("trigger_transaction_id", candidateTxIds);
        if (existingError) {
          throw new Error(`Failed to check existing alert_events: ${existingError.message}`);
        }
        const existingKeys = new Set(
          (existingData || []).map((e: { alert_rule_id: string; trigger_transaction_id: string }) =>
            `${e.alert_rule_id}:${e.trigger_transaction_id}`
          ),
        );

        const newRows = candidates
          .filter((c) => !existingKeys.has(`${c.rule.id}:${c.tx.id}`))
          .map((c) => ({
            alert_rule_id: c.rule.id,
            user_id: c.rule.user_id,
            trigger_transaction_id: c.tx.id,
            message: `${walletLabel(c.tx.wallets)} made a ${formatUsd(Number(c.tx.value_usd))} transaction` +
              (c.tx.tokens ? ` in ${tokenTicker(c.tx.tokens)}` : ""),
          }));

        for (const row of newRows) walletRuleIdsTriggered.add(row.alert_rule_id);

        if (newRows.length > 0) {
          const { error: insertError } = await supabase.from("alert_events").insert(newRows);
          if (insertError) throw new Error(`Failed to insert wallet alert_events: ${insertError.message}`);
          walletEventsInserted = newRows.length;
        }
      }
    }

    // ---- price_change_pct ----
    let priceEventsInserted = 0;
    const priceRuleIdsTriggered = new Set<string>();

    if (priceRules.length > 0) {
      const tokenIds = Array.from(new Set(priceRules.map((r) => r.token_id as string)));
      const { data: tokenData, error: tokenError } = await supabase
        .from("tokens")
        .select("id, ticker, name, price_change_24h")
        .in("id", tokenIds);
      if (tokenError) throw new Error(`Failed to load tokens: ${tokenError.message}`);
      const tokenById = new Map(
        ((tokenData || []) as TokenPriceRow[]).map((t) => [t.id, t]),
      );

      const cooldownMs = PRICE_ALERT_COOLDOWN_HOURS * 60 * 60 * 1000;
      const now = Date.now();
      const priceEventRows: Record<string, unknown>[] = [];

      for (const rule of priceRules) {
        const token = tokenById.get(rule.token_id as string);
        if (!token) continue;

        const change = Number(token.price_change_24h) || 0;
        const meetsCondition = rule.direction === "up" ? change >= rule.threshold : change <= -rule.threshold;
        if (!meetsCondition) continue;

        if (rule.last_triggered_at) {
          const elapsedMs = now - new Date(rule.last_triggered_at).getTime();
          if (elapsedMs < cooldownMs) continue;
        }

        priceEventRows.push({
          alert_rule_id: rule.id,
          user_id: rule.user_id,
          trigger_transaction_id: null,
          message: `${tokenTicker(token)} price ${rule.direction === "up" ? "rose" : "dropped"} ${
            Math.abs(change).toFixed(1)
          }% (24h)`,
        });
        priceRuleIdsTriggered.add(rule.id);
      }

      if (priceEventRows.length > 0) {
        const { error: insertError } = await supabase.from("alert_events").insert(priceEventRows);
        if (insertError) throw new Error(`Failed to insert price alert_events: ${insertError.message}`);
        priceEventsInserted = priceEventRows.length;
      }
    }

    const triggeredRuleIds = [...walletRuleIdsTriggered, ...priceRuleIdsTriggered];
    if (triggeredRuleIds.length > 0) {
      const { error: updateError } = await supabase
        .from("alert_rules")
        .update({ last_triggered_at: new Date().toISOString() })
        .in("id", triggeredRuleIds);
      if (updateError) throw new Error(`Failed to update last_triggered_at: ${updateError.message}`);
    }

    const summary = {
      ok: true,
      active_rules_scanned: rules.length,
      wallet_rules_scanned: walletRules.length,
      price_rules_scanned: priceRules.length,
      wallet_events_inserted: walletEventsInserted,
      price_events_inserted: priceEventsInserted,
      rules_triggered: triggeredRuleIds.length,
      checked_at: new Date().toISOString(),
    };

    return new Response(JSON.stringify(summary, null, 2), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: message }, null, 2), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});

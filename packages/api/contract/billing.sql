-- Provider subscriptions linked to API keys, written only by the Lemon Squeezy
-- webhook (src/auth/lemonsqueezy.ts). subscription_item_id is what usage
-- records are posted against; status mirrors the provider's last event.
CREATE TABLE IF NOT EXISTS billing_subscriptions (
    key_id               TEXT NOT NULL REFERENCES api_keys(id),
    provider             TEXT NOT NULL,
    subscription_id      TEXT NOT NULL,
    subscription_item_id TEXT NOT NULL,
    variant_id           TEXT NOT NULL,
    status               TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    PRIMARY KEY (key_id, provider)
);
CREATE INDEX IF NOT EXISTS billing_subscriptions_sub_idx ON billing_subscriptions(provider, subscription_id);

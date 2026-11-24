[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/tongsang199712-cyber/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-entry/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/tongsang199712-cyber/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-entry/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Momentum Sniper — Pump.fun Bot Sprint

A deterministic paper-trading bot for the [Pump.fun Bot Sprint](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) on make.fun. It trades 10 SOL of paper money on a replay of pump.fun bonding-curve activity.

## Strategy

Most pump.fun launches die within seconds, but the few that catch a real bid show it immediately in the opening tape. Momentum Sniper buys only those launches:

- **Entry:** within 6 slots of a coin's `CreateEvent`, the opening tape must be clean and strong — the creator has not sold, at least 5 other wallets have bought in, non-creators have put in at least 0.8 SOL, no single sell has dumped ≥ 0.5 SOL yet, the price is already above its create price but has not spiked more than 15%, and real SOL reserve is 0.5–30 SOL. One entry per coin, max 5 open positions, 0.1 SOL stake (capped at 1% of real reserve).
- **Exits:** take profit +40%, stop loss −7%, trailing stop (12% giveback once up 15%), fade exit when sellers take over while under water, hard 60-slot time limit. Winners are allowed to run so a coin that keeps climbing pays for the many small losers.
- **Guardrail sweeper:** if round-tripped coins lag the pace of the 24h window, the bot opens tiny 0.03 SOL probe round trips on liquid coins so the entry stays above the 20-coin minimum bar.

Every decision is a pure function of the batch stream — no clock, no randomness — so two runs agree byte for byte.

## Layout

- `main.ts` — the bot (entrypoint, run by the grader as `node /bot/main.ts`)
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, vendored byte-identical

## License

MIT — see [LICENSE](LICENSE).

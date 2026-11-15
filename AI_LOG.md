# AI usage log (controlled use)

Tool: Claude Code. Human owns requirements, architecture decisions and acceptance.

| # | What AI did | How it was verified |
|---|---|---|
| 1 | Scaffolded zero-dependency Node service (store, routing, crisis engine, API, UI) | Read through by the team; 32 automated tests (`npm test`) |
| 2 | Wrote the tests for the 4-SOS/500 m/5 min rule, 95 % rule, reroute, outage fallback, auth, rate limit | Tests include boundary cases (exactly 95 %, spam from one citizen, SOS older than 5 min) |
| 3 | Load test found p95 ≈ 960 ms: crisis rule re-evaluated whole window per SOS (O(n²)). Fixed by focusing evaluation on the new SOS | Re-ran `npm run load`: p95 ≈ 12 ms, ~6.7k req/s; tests still green |
| 4 | Drafted az/en/ru dictionary | Test asserts all languages have identical keys; **human must proof-read Azerbaijani/Russian wording** |

Rules we follow: AI output is never merged without running tests; secrets are never pasted into prompts; every AI-found bug is added as a test.

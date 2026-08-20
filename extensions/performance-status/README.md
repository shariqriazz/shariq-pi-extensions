# Performance Status

Adds one compact footer-area status row for the current or latest assistant response.

It reports TPS, time to first token, elapsed response time, response output tokens, and the active tool. Live token counts and TPS are estimates until the provider returns final usage. Final TPS uses conventional decode throughput: provider-reported output tokens divided by first-token-to-message-completion time. TTFT and total elapsed time separately expose provider latency, prefill, and hidden reasoning.

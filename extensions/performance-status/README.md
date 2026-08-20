# Performance Status

Adds one compact footer-area status row for the current or latest assistant response.

It reports TPS, time to first token, elapsed response time, response output tokens, and the active tool. Live token counts and TPS are estimates until the provider returns final usage. Final TPS divides provider-reported output tokens by full request-to-message time, including provider latency, prefill, and hidden reasoning.

# Per-service schemas and extractors

One JSON file per seller domain, e.g. `api.example.com.json`:

```json
{
  "domain": "api.example.com",
  "json_schema": { "...": "JSON Schema draft 2020-12 for the response body" },
  "entity": {
    "request_param": "symbol",
    "response_path": "$.data.symbol"
  },
  "freshness": { "response_path": "$.data.timestamp", "max_age_seconds": 3600 },
  "max_timeout_seconds": 30
}
```

Any section that is absent makes the corresponding validator return
`skipped` with reason `no_config`, and the call is flagged `schema_missing`.
Validators never pass by default.

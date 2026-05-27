# music-time-agent output spec

Successful output:
```json
{
  "status": "played",
  "time": "local ISO timestamp",
  "slot": "slot id",
  "plan": {
    "user_profile": "LLM inferred current-slot listener profile",
    "keyword": "LLM generated keyword",
    "alternate_keywords": ["LLM generated backup keyword"],
    "search_strategy": "short description of how the LLM shaped the query",
    "reason": "short reason",
    "preferred_language": "language preference",
    "avoid": "avoidance notes"
  },
  "searchAttempts": [
    {
      "keyword": "keyword attempted",
      "strategy": "LLM strategy for this attempt",
      "status": "failed|matched",
      "error": "exact search error if failed"
    }
  ],
  "selectedKeyword": "keyword that produced the playable result",
  "selected": {
    "encryptedId": "32 hex chars",
    "originalId": "numeric string",
    "name": "song name if provided",
    "artist": "artist if provided"
  },
  "queue": {
    "count": "number of playable search results shuffled into the queue",
    "added": "number of songs appended after the first played song",
    "order": [
      {
        "encryptedId": "32 hex chars",
        "originalId": "numeric string",
        "name": "song name if provided",
        "artist": "artist if provided"
      }
    ]
  }
}
```

Failure output:
```json
{
  "status": "failed",
  "error": "explicit failure reason"
}
```

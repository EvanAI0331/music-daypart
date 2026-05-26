# music-time-agent search skill

Purpose:
- Guide the LLM search planner when converting a time slot, user keywords, and intent direction into NetEase Cloud Music search terms.

Rules:
- Intent is search direction, not a literal keyword source.
- Prefer concrete music terms from the slot keywords: genre, scene, language, singer type, instrument, mood words that users commonly search.
- Keep each query short and searchable: 1-3 terms, normally under 12 Chinese characters.
- Avoid abstract control words as search terms: 唤醒, 恢复, 执行, 时段, 不要, 低 BPM.
- If a query fails, change strategy instead of only reordering the same words.
- Strategy changes can broaden, simplify, switch genre/scene wording, remove constraints, or use a more common synonym.
- Never invent a fixed song or hardcoded artist as a fallback.

Retry strategy:
1. First attempt: use the strongest concrete terms from slot keywords.
2. If no result: remove abstract or rare words and search broader genre/mood.
3. If still no result: drop singer/instrument constraints and keep only scene or genre.
4. If still no result: use a common NetEase-style broad query consistent with intent direction.

Output expectation:
- Return JSON only.
- `keyword` must be the next query to run.
- `search_strategy` must describe what changed from failed attempts.
- Do not repeat any failed keyword from the provided failure history.

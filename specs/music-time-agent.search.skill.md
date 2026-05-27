# music-time-agent search skill

Purpose:
- Guide the LLM search planner when converting a time slot, user keywords, and intent direction into NetEase Cloud Music search terms.

Rules:
- Intent is search direction, not a literal keyword source.
- Build a concise time-slot listener profile before generating any query.
- Use slot keywords as preference evidence for that profile: genre, scene, language, singer type, instrument, mood, and listening context.
- Do not directly reuse a slot keyword as the query; transform preference evidence into a profile-derived NetEase search phrase.
- Use negative keywords as hard exclusions: excluded genre, scene, artist type, language, energy level, or mood must not appear in query terms or strategy direction.
- Prefer concrete music terms derived from the profile: genre, scene, language, singer type, instrument, mood words that users commonly search.
- Keep each query short and searchable: 1-3 terms, normally under 12 Chinese characters.
- Avoid abstract control words as search terms: 唤醒, 恢复, 执行, 时段, 不要, 低 BPM.
- If a query fails, change strategy instead of only reordering the same words.
- Strategy changes can broaden, simplify, switch genre/scene wording, remove constraints, or use a more common synonym.
- Never invent a fixed song or hardcoded artist as a fallback.

Retry strategy:
1. First attempt: infer the strongest listener profile from positive and negative keywords, then search a natural NetEase phrase that matches the profile.
2. If no result: remove abstract or rare words and search broader genre/mood while preserving negative exclusions.
3. If still no result: drop singer/instrument constraints and keep only scene or genre, still avoiding negative directions.
4. If still no result: use a common NetEase-style broad query consistent with intent direction and profile, not a prohibited direction.

Output expectation:
- Return JSON only.
- `user_profile` must summarize the inferred listener profile and mention important exclusions when present.
- `keyword` must be the next query to run.
- `search_strategy` must describe what changed from failed attempts.
- `avoid` must include the negative keywords and any derived exclusion rules.
- Do not repeat any failed keyword from the provided failure history.

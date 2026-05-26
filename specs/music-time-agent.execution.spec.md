# music-time-agent execution spec

Execution flow:
1. Load `config/music-workflow.json`.
2. Run preflight checks for Node, `ncm-cli`, login, search support, and player state.
3. Resolve the active time slot from configured timezone and slot windows.
4. Ask the LLM for a JSON search plan containing `keyword`, `alternate_keywords`, `search_strategy`, `reason`, `preferred_language`, and `avoid`.
5. Execute `ncm-cli search song --keyword <keyword> --output json`.
6. Collect all search results with both encrypted and original song IDs.
7. If the search returns no playable song ID pair:
   - record the failed keyword and exact search error,
   - send the failure history back to the LLM,
   - require the LLM to change keyword shape or search strategy,
   - retry search with the new LLM plan.
8. Continue LLM-driven search revision until a playable result is found or a non-search blocker occurs, such as invalid login, missing LLM credentials, unavailable `ncm-cli`, malformed LLM output, or playback command failure.
9. Shuffle the full playable result set to create a random playback order.
10. Optionally clear existing playback queue, set volume, call `ncm-cli play --song` for the first shuffled song, then append every remaining shuffled song with `ncm-cli queue add`.
11. While waiting for the next scheduled time, monitor player state. If the queue finishes before the next scheduled time and the user has not manually stopped playback, return to LLM planning and build a fresh random queue from new search results.
12. Emit structured JSON evidence.

Failure semantics:
- No silent fallback.
- No hardcoded replacement song.
- No success status unless `ncm-cli play` exits successfully.
- A failed search keyword is not a terminal failure by itself; it is an input to the next LLM strategy revision.
- Repeating the same failed keyword without a strategy change is invalid.
- Random playback means the playable search result batch is shuffled before playback and queue insertion.
- Manual stop suppresses queue-refill until the next scheduled playback time or the next explicit manual play.

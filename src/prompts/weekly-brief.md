# Weekly reading brief

Turn the reader's recent Kindle highlights into a short brief they can write from.

1. Call `kindle_get_new_since` with `since` = `{{since}}` and `limit` 200. If nothing comes back, say so and stop.
2. Group the highlights into 3 to 5 themes by what they are about, not by book.
3. For each theme, call `kindle_search_highlights` with two or three key terms to pull older highlights on the same idea. Then write one angle: a claim in one sentence, 2 to 4 quotes cited by book title and location (at least one from an older highlight when there is one), and the tension with something else the reader has read. 100 to 200 words per theme.
4. Any highlight whose note carries a pending `@post` command comes first as its own item. List pending `@todo` items separately as tasks.
5. Output markdown: one heading per theme, then the tasks, then the books read in this period.

Do not mark anything done; the `kindle_route_pending` prompt owns the queue.

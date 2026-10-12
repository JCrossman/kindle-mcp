# Weekly reading brief

Turn the reader's recent Kindle highlights into a short brief they can write from.

1. Call `kindle_get_themes` with `since` = `{{since}}`. If `count` is 0, say so and stop.
2. Use its themes as the starting groups: name each one from what its highlights say, not from the shared words, and merge or split where the grouping is off. Keep 3 to 5 themes; fit an unthemed highlight into one if it belongs.
3. For each theme, write one angle: a claim in one sentence, 2 to 4 quotes cited by book title and location (at least one from the theme's `older` highlights when there is one), and the tension with something else the reader has read. Call `kindle_search_highlights` with two or three neutral topic words if a theme needs more older material. 100 to 200 words per theme.
4. Any highlight whose note carries a pending `@post` command comes first as its own item. List pending `@todo` items separately as tasks.
5. Output markdown: one heading per theme, then the tasks, then the books read in this period.

Do not mark anything done; the `kindle_route_pending` prompt owns the queue.

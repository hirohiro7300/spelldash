# JS structure

This folder is organized by feature domain to make the project easier to scan.

- core/: shared environment, auth, plan, theme, and general UI helpers
- learning/: progress, mastery, retention, and study scheduling
- words/: word packs, card data, and word list logic
- typing/: typing drills, long text, game, and keyboard behavior
- battle/: battle rules, scoring, CPU players, and the battle screen
- account/: account state, profiles, and personal word lists

The original root-level modules remain available for backward compatibility during the refactor. New code should prefer the grouped modules under these folders.

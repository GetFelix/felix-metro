- `dev/check-restart.mjs` also checks that the keyframes after a restart still say who built each lot, and when.
- `web/scripts/check-attribution.mjs` hovers a building someone built and a generated one in the live page, reads the
  card, and follows "See it go up". CI runs it in the dev-stack job.

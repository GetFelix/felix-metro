- A `fork` command makes a new city `<city>~<name>` from a past tick. The fork copies the parent's history through that
  tick into streams of its own, is listed in the registry with who made it, and ticks on independently. New result codes
  16 to 19 refuse a bad or too deep name, a tick that has not run and a name already taken, and a `forked` event
  (extended kind 7) records it in the parent. A sim needs `SIM_FORK_PROVISION_URL` (a service that makes the streams;
  the dev stack runs `dev/provision.mjs`) or it refuses `fork` as before. A fork has its parent's seed, so `City::generate`
  and `resident_name` draw from the part of the name before the first `~`. The registry's `forked` record gains the
  forking principal. See docs/design.md, Branching.
  Result 20 refuses a fork of a city whose log retention has trimmed, and 21 a fork past `SIM_MAX_FORKS_PER_CITY` (default
  8, forks of forks counted against the root). A fork's copy leaves out its parent's `forked` events, a restart resumes
  only a city's own forks, and a fork listed twice in the registry starts one city. City names in `SIM_CITIES` and
  `SIM_ON_DEMAND` may no longer hold `_`.

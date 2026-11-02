# Felix Metro as a game

[design.md](design.md) describes a city you watch and build in, and a log you
can scrub through. This note is about what turns that into something you play: a
reason to act, a way to know how you are doing, and choices that cost something.

The rule for every mechanic here is the same as for the rest of Felix Metro: it is
expressed in the log. The budget is events, a policy is a command, a goal is checked
against what the streams hold. A mechanic that needs a second datastore or a hidden
server-side state is out.

## The pitch

You are the new mayor of a city with a complete memory. Everything that ever happened
in it is on the timeline, and you can go back and look. The council hands you
problems; you find out why they happen, try a fix in a branch of the city, and adopt
the one that works.

Time travel is the core mechanic, not a viewer feature. Most city builders hide the
past behind graphs. Here the past is the city itself, at any moment, and the
interesting questions ("why did the bridge jam at 08:10 yesterday?") are answered by
going there.

## The loop

1. **Look.** Watch the city live, or scrub back to when something went wrong.
2. **Diagnose.** Follow a resident, a car or a street to find the cause.
3. **Try.** Fork the city at a past moment, change something (build, zone, set a
   policy), and run the branch fast.
4. **Compare.** Put the branch beside the real timeline at the same tick, with the
   numbers the goal cares about.
5. **Commit.** Apply the change to the live city, pay for it, and live with it.

A turn of the loop takes a few minutes of play and a city day or two of city time.

## The pieces

### Money

The city has one account. Every change to it is an event in the district that caused
it, so the budget is a ledger you can scrub like everything else.

| In                                                            | Out                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| Residents' tax, per resident per day at home                  | Upkeep per road tile and per public building, per day    |
| Business tax, per shop, office and factory per day it is open | Building and demolishing, once, when the command applies |
| Fares, if transit exists                                      | Services (parks, transit) per day                        |

Paying daily rather than per tick keeps the log cost to one `ledger` event per
district per city day plus one per command, which is noise next to trips.

A city that runs out of money cannot build. It does not lose; the council notices.

### Land value and demand

Each lot has a value from what is near it: distance to work and shops along the road
graph, noise from arterials and industry, parks. It is derived from the city, not
stored, so a keyframe does not grow.

Demand decides who moves in. Empty homes with good value fill first; homes far from
work empty out over days. This is the first slow consequence a player sees: a road
built today changes who lives where a week from now.

Moving in and out is a resident joining or leaving, a new event kind. The resident
table stays fixed by the seed; a resident is either living in the city or not.

### Policy

A policy is a command on the command stream, like `build` today, recorded with who set
it. Each policy can change once a city day. A first set, each with a visible effect and a cost:

- **Shop hours.** Done (see Policy in design.md). Later hours spread the evening rush and
  raise business tax. The noise they should cost is not built.
- **Speed limits** on a street class. Done for avenues and streets: a lower limit lengthens
  every trip that drives them. The safety, quiet and land value effects are not built.
- **Parking** in a district. Fewer spaces push short trips onto foot and longer ones
  elsewhere.
- **Tax rates.** Higher tax fills the account and slows moving in.

The sim is deterministic, so a policy's effect replays exactly, and a fork that sets
it shows what it would have done.

### Goals

A chapter sets a situation and up to three goals, each a number the log can answer:

- the median morning commute in a district, from `trip` and `arrived` events
- residents living in the city, from moving in and out
- the account at the end of a day, from `ledger` events
- cars on a named street at the rush peak, from routes

Checking a goal reads the streams. It needs no extra state, and anyone can check it
again later by reading the same range.

### Investigations

Tasks the log answers and nothing else does: "A delivery van was stuck for half an
hour yesterday afternoon. Where, and why?" The player scrubs back, follows the van,
and points at the cause: a moment and a place. The answer is checked against the
events, so it cannot be guessed from a dashboard.

These teach the timeline better than a tutorial does, and they are cheap to write: a
scenario seed, a planted cause, and a question.

### What-ifs

A fork (Branching in design.md) is how a player tries a change without paying for it
in the real city. The fork runs fast from the fork tick, then sits beside the parent
with both timelines locked to the same tick and the goal's numbers for each.

Adopting a branch does not copy it into the live city. The player applies the same
commands to the live city, which replays them from now and may turn out differently.
That difference is part of the game: the city moved on while you were testing.

### Story

The council is the voice of the game. It brings a problem, sets the chapter's goals,
and reacts to how the city is going. Events give chapters a shape:

- a factory closes and its workers have to find work
- a storm closes the coast road for a day
- a festival fills the centre on one evening
- a new employer opens in a district with no housing nearby

Each is a command from the scenario, recorded like a player's, so a replay of a
chapter shows what the game did and what the player did.

Residents you can follow (Follow a life in design.md) carry the story at street level:
the same shift worker you watched get stuck on the bridge in chapter one is the one
whose commute you are trying to fix.

### Several mayors

Every command carries who sent it, so a shared city already knows who did what. Later,
several mayors can run districts of one city, with a shared account or separate ones,
and the timeline answers "who broke the traffic?". This comes after single-player
works.

## A first chapter

**Pier, day 1.** The city opens with its avenues limited to 40% of their speed and its streets to 60%. Trips to work
or school average 24 city minutes, the commuters are unhappy, and the council recalls the mayor in 3 days.

Goals, judged when day 3 has been scored:

1. Trips to work or school average 16 city minutes or less.
2. No faction has recalled the mayor.
3. The account stays above $0.

The player has the council, the policies, the timeline and the resident's day. The cause is in the policies: the
speed limits are the only thing that moves the commute, and a limit can be changed once a city day. Reading the
council to see what commuters want, finding the limits under it and sending the change is the whole chapter. Until the page has
a control for policies, `node dev/policy.mjs pier avenue 100` sends one. Raising
both limits meets the goals; raising one does not, because the avenue limit alone brings the commute to 17.5 minutes
and the street limit alone to 20.

This is a first chapter, so it is easy. The limits cost nothing, so the choice is not yet a trade-off. A
chapter that sets the commute against money or against another faction needs a lever that costs something, such as
roads, zones or transit.

Pier starts at its first tick, without the day and a half of history other cities commit before anyone looks, so
the three days are the player's. At the usual four ticks a second they take 72 minutes; `dev/speed.sh pier 16` runs them
in 18.

## What this needs from the sim and the log

- **Money.** Done: the account, the `ledger` and `balance` events and the refusal when the city cannot pay are in the
  sim and shown as a number beside the clock (see Money in design.md); the timeline does not draw it yet. Parks cost
  upkeep as land; transit, fares and paid services are not built.
- **Factions.** Done: the sim scores three factions once a city day, writes a `council` event on every keyframe tick
  and counts the days a faction stays unhappy; the page shows them with the recall countdown (see The council in
  design.md). A recall changes nothing in the sim; a chapter's page treats it as a loss.
- **Persistence across a restart.** Done: a restarted sim resumes from the newest keyframe
  and the records after it (see Restart in design.md). The new state below has to be
  rebuilt the same way, so each new piece of state is restored in `sim/src/world/restore.rs`. The account is written as
  a `balance` event on keyframe ticks, not as a keyframe field, so the keyframe layout stays as it is.
- **Policy.** Done: the `policy` command, the `policy` event on a change and on every keyframe tick, and a cooldown
  (see Policy in design.md).
- **New events:** `moved` (a resident joining or leaving). It is small and rare next to `trip`.
- **Keyframe ticks carry** the set of residents living in
  the city (a bitmap, 2.5 KB at 20,000 residents).
- **Log budget.** None of this should move the per-second rate measurably; the check is
  `report_load` before and after.
- **Forks** (design.md, Branching) before what-ifs, and a fast-forward for a fork that
  runs as fast as the broker accepts commits.
- **Goal checks** as a small library over range reads, shared by the page and CI, so a
  chapter's goals are tested the same way the player sees them.

## Order

1. Persistence across a restart (done).
2. Money and the `ledger` event, shown as one number on the page (done; the timeline does not draw it yet).
3. Factions: three satisfaction numbers from the log, their demands, and the recall
   warning with its countdown (done).
4. Policy commands (shop hours and a speed limit for each road class), with a cooldown (done).
5. Goals and the first chapter, without forks: the player commits changes for real.
6. Investigations, one or two, checked as a batch.
7. Measure a fork's morning rush on one broker; then forks, what-ifs and policy
   previews.
8. Comparing a chapter's fix with other players' fixes.
9. Demand, moving in and out, land value.
10. Story events and more chapters; the public city as a creative mode.
11. Several mayors.

Each step is playable on its own. The first chapter is the test: if it is not fun
without forks, forks will not save it.

## Decisions, from comparable games

**Players own their cities; one public city is a toy.** SimCity (2013) built play
around shared regions and always-online, and it cost the game its launch and its city
sizes ([Quigley](https://simscommunity.info/2016/05/21/ocean-quigley-opens-up-on-why-simcity-2013-failed/));
its cities shared utilities but not commuters, so the link felt fake
([forum](https://forums.ea.com/discussions/simcity-franchise-discussion-en/few-questions-in-regards-to-regions/10449462)).
Shared worlds that work are scarce and bounded: r/place gave one pixel every five
minutes for 72 hours ([Reddit](https://fastly.com/blog/reddit-on-building-scaling-rplace)),
and a Foxhole war ends ([Foxhole](https://www.foxholegame.com/about-foxhole)). So
chapters run in a city the player owns, and the public showcase city is a creative mode
with no goals, where every command shows who sent it. Like Townscaper, it is a toy
([Bloomberg](https://www.bloomberg.com/news/articles/2020-07-24/the-video-game-where-you-build-an-empty-town)).

**A what-if answers in under 10 seconds.** Ten seconds is about as long as a wait holds
attention ([Nielsen](https://nngroup.com/articles/response-times-3-important-limits)), and
Cities: Skylines players complain about fast-forward that crawls in big cities
([Steam](https://steamcommunity.com/app/949230/discussions/0/4041481833163552062)). A fork
runs only the goal's window (one morning rush, not a day), streams in as it runs, and
the player can keep working meanwhile. Into the Breach shows the outcome of every move
before you make it, so losses feel like your own
([interview](https://gamedeveloper.com/game-platforms/road-to-the-igf-subset-games-i-into-the-breach-i-)).
A what-if should do the same for a policy, with the real effect rather than an estimate.

**A chapter can fail; a city never ends.** The council can recall the mayor, Frostpunk
style ([Frostpunk](https://en.wikipedia.org/wiki/Frostpunk)), but only after a visible
warning and a countdown, the way an overcrowded Mini Metro station pulses before the
game ends ([review](https://www.podfeet.com/blog/2016/11/mini-metro/)). The city keeps
running, and the loss itself becomes an investigation: scrub back and see where it went
wrong.

**Investigations are checked in batches, and hints are leads.** Return of the Obra Dinn
confirms fates only three at a time, so guessing doesn't pay
([Obra Dinn](https://en.wikipedia.org/wiki/Return_of_the_Obra_Dinn)). Outer Wilds shows
what you've found as a web of leads, with a mark where there is more to learn
([Outer Wilds](https://wikipedia.com/wiki/Outer_Wilds)). Paradise Killer lets evidence come
in any order
([interview](https://filmstories.co.uk/features/paradise-killer-and-designing-a-gripping-courtroom-drama/)).
An investigation here asks two or three linked questions (where, when, why) and checks
them together. A hint names a street or an hour worth looking at, never the answer.

## Changes this makes to the pieces above

- **The council is factions:** commuters, harbor residents and business, each with a
  satisfaction number drawn from the log and its demands visible up front, as in
  Tropico ([interview](https://www.gamingnexus.com/Article/3167/Tropico-4-Interview)).
  A recall comes from them.
- **Policies show their effect before you adopt them, and have a cooldown.** Frostpunk
  lists a law's immediate and ongoing effects and what it rules out
  ([wiki](https://frostpunk.gamepedia.com/Administration)). Here a policy's preview is a
  short what-if.
- **Money stays at the three rows above** until playtests ask for more. Islanders works
  with almost nothing ([interview](https://www.thexboxhub.com/?p=114178)).
- **Fixes are compared with other players' fixes.** After a chapter, the player's
  numbers sit on histograms of everyone's committed fixes, as Opus Magnum does
  ([Engadget](https://www.engadget.com/2018-07-09-opus-magnum-zachtronics-irl.html)).
  Commands already carry who sent them.

## The pressure the player feels

Factions are the main pressure and money is the constraint. A player reads "harbor
residents are angry about the bridge" more easily than a falling balance, and a
faction can say why. Money decides what you can afford to do about it. The page
shows the three factions' satisfaction and the account, nothing else, until a chapter
needs more.

## Measured before it is promised

Forks go into the order only once one broker runs a morning rush (about 1,000 ticks
of one city) in under 10 seconds. If it can't, the what-if shrinks to the goal's
street or district rather than the wait growing.

# Felix Metro as a game

Draft. [design.md](design.md) describes a city you watch and build in, and a log you
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

| In | Out |
|---|---|
| Residents' tax, per resident per day at home | Upkeep per road tile and per public building, per day |
| Business tax, per shop, office and factory per day it is open | Building and demolishing, once, when the command applies |
| Fares, if transit exists | Services (parks, transit) per day |

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
it. A first set, each with a visible effect and a cost:

- **Shop hours.** Later hours spread the evening rush and raise business tax, and
  cost noise.
- **Speed limits** on a street class. Slower streets are safer and quieter and raise
  nearby land value, and slow the trips that use them.
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

**Harbor, day 1.** The council says the morning commute into the centre has got
worse, and the harbor district is losing residents.

Goals, by the end of day 3:

1. Median morning commute into the centre under 12 city minutes (today about 16).
2. Harbor keeps at least 480 residents (today 522 and falling).
3. The account is positive at the end of each day.

The player has the timeline, follow, building, two policies (shop hours and speed
limits) and one fork. The cause is planted: one bridge carries most of the morning
traffic, and an industrial lot beside it makes the homes near it worth little. There
are several fixes, and each costs something else.

The numbers are placeholders until the economy is in the sim and measured.

## What this needs from the sim and the log

- **Persistence across a restart.** Today a restarted sim begins again at tick 0 with
  the generated city, and what builders built is lost. A game cannot do that. The sim
  has to resume from the newest keyframe and the records after it.
- **New events:** `ledger` (account changes), `moved` (a resident joining or leaving),
  `policy` (a policy's value changed). Each is small and rare next to `trip`.
- **Keyframes grow by** the account, policy values and the set of residents living in
  the city (a bitmap, 2.5 KB at 20,000 residents).
- **Log budget.** None of this should move the per-second rate measurably; the check is
  `report_load` before and after.
- **Forks** (design.md, Branching) before what-ifs, and a fast-forward for a fork that
  runs as fast as the broker accepts commits.
- **Goal checks** as a small library over range reads, shared by the page and CI, so a
  chapter's goals are tested the same way the player sees them.

## Order

1. Persistence across a restart.
2. Money and the `ledger` event, shown as one number on the page and on the timeline.
3. Policy commands, two of them.
4. Goals and the first chapter, without forks: the player commits changes for real.
5. Investigations, one or two.
6. Forks and what-ifs.
7. Demand, moving in and out, land value.
8. Story events and more chapters.
9. Several mayors.

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

## Still open

- How fast one broker can run a fork's morning rush. The 10-second budget needs a
  measurement before forks go in the order.
- Whether factions replace the account as the main pressure or sit beside it.

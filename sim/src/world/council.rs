//! The council: three factions, scored once a city day from what the city did.
//!
//! Commuters judge the average trip to work or school, the shore's residents
//! judge how many of them live away from factories, and the shops judge how
//! many visits each gets. A faction below [`UNHAPPY_BELOW`] for [`PATIENCE`] days in
//! a row recalls the mayor, and the city carries on. The demands are
//! placeholders until the city has been played.

use std::collections::{HashMap, HashSet};

use felix_metro_core::record::{
    Event, FACTION_BUSINESS, FACTION_COMMUTERS, FACTION_RESIDENTS, FACTIONS, Standing, Tally,
};
use felix_metro_core::{Activity, BuildingKind, City};

use super::World;

#[cfg(test)]
mod tests;

/// Commuters ask for an average trip to work or school of at most this many
/// ticks (12 city minutes).
const COMMUTE_DEMAND: u32 = 48;
/// Residents ask for this percent of themselves to live away from factories.
const QUIET_DEMAND: u32 = 80;
/// Shops ask for this many visits a day each.
const VISITS_DEMAND: u32 = 5;
/// A factory this many tiles from a home along either axis, so inside a square
/// around the home's tile, makes it noisy.
const NOISE_RADIUS: u16 = 3;
/// Below this satisfaction a faction is unhappy for the day.
const UNHAPPY_BELOW: u8 = 60;
/// Days a faction can stay unhappy before the council recalls the mayor.
pub(crate) const PATIENCE: u8 = 3;

/// Where the factions stand, and what the open day has added up toward the
/// next score.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Council {
    /// City days scored so far.
    pub(crate) days: u32,
    pub(crate) standings: [Standing; FACTIONS],
    pub(crate) tally: Tally,
}

impl Council {
    /// A council that has scored nothing: every faction content, asking for
    /// its demand.
    pub(crate) fn new() -> Council {
        let standing = |demand| Standing {
            demand,
            measure: 0,
            satisfaction: 100,
            unhappy_days: 0,
        };
        let mut standings = [standing(0); FACTIONS];
        standings[FACTION_COMMUTERS] = standing(COMMUTE_DEMAND);
        standings[FACTION_RESIDENTS] = standing(QUIET_DEMAND);
        standings[FACTION_BUSINESS] = standing(VISITS_DEMAND);
        Council {
            days: 0,
            standings,
            tally: Tally::default(),
        }
    }

    /// The council a `council` event describes, or `None` for any other event.
    pub(crate) fn from_event(event: &Event) -> Option<Council> {
        match *event {
            Event::Council {
                days,
                standings,
                tally,
                ..
            } => Some(Council {
                days,
                standings,
                tally,
            }),
            _ => None,
        }
    }

    /// Counts a trip that has just ended. `ticks` is how long it took and
    /// `activity` what the resident arrived to do.
    pub(super) fn arrived(&mut self, activity: Activity, ticks: u32) {
        match activity {
            Activity::Work | Activity::School => {
                self.tally.commutes += 1;
                self.tally.commute_ticks += u64::from(ticks);
            }
            Activity::Shop => self.tally.visits += 1,
            Activity::Home | Activity::Leisure => {}
        }
    }

    /// Scores the day that just ended from the tally and `quiet`, the percent
    /// of the shore's residents with no factory near home, and starts the next
    /// day's.
    fn score(&mut self, quiet: u32, shops: u32) {
        let tally = std::mem::take(&mut self.tally);
        // `None` when there is nothing to judge: nobody commuted, or there are no shops.
        let commute = tally
            .commute_ticks
            .checked_div(u64::from(tally.commutes))
            .map(|ticks| ticks as u32);
        let visits = (shops > 0).then(|| (tally.visits + shops / 2) / shops);
        let measures = [
            (FACTION_COMMUTERS, commute, true),
            (FACTION_RESIDENTS, Some(quiet), false),
            (FACTION_BUSINESS, visits, false),
        ];
        for (faction, measure, lower_is_better) in measures {
            let standing = &mut self.standings[faction];
            standing.measure = measure.unwrap_or(0);
            standing.satisfaction =
                measure.map_or(100, |m| satisfaction(standing.demand, m, lower_is_better));
            standing.unhappy_days = if standing.satisfaction < UNHAPPY_BELOW {
                standing.unhappy_days.saturating_add(1)
            } else {
                0
            };
        }
        self.days += 1;
    }
}

/// 100 when `measure` meets `demand`, falling in proportion to how far short
/// it is. For a commute, shorter is better.
fn satisfaction(demand: u32, measure: u32, lower_is_better: bool) -> u8 {
    let (good, bad) = if lower_is_better {
        (demand, measure)
    } else {
        (measure, demand)
    };
    if bad == 0 {
        return 100;
    }
    (u64::from(good) * 100 / u64::from(bad)).min(100) as u8
}

/// True for a factory kind, which is what makes a home noisy.
fn is_factory(kind: u16) -> bool {
    (u16::from(BuildingKind::FACTORY_FIRST)..u16::from(BuildingKind::TREE_FIRST)).contains(&kind)
}

/// Whether `district` is one residents are scored in: those along the shore,
/// or every district in a city with no shore.
fn in_scope(city: &City, district: u16) -> bool {
    let side = city.districts_per_side;
    let d = &city.districts[usize::from(district)];
    match city.shore {
        None => true,
        Some(0) => d.z == 0,
        Some(1) => d.x == side - 1,
        Some(2) => d.z == side - 1,
        Some(_) => d.x == 0,
    }
}

impl World {
    /// Scores the city day that just ended and starts the next one's tally.
    pub(super) fn score_day(&mut self) {
        let quiet = self.quiet_percent();
        let shops = self.shops_standing();
        self.council.score(quiet, shops);
    }

    /// How many shops residents go to that are still shops: a lot nobody
    /// has a shop block at gets no visits, so it can't make business unhappy.
    fn shops_standing(&self) -> u32 {
        let visited: HashSet<u32> = self
            .people
            .iter()
            .flat_map(|p| &p.resident.schedule.blocks)
            .filter(|b| b.activity == Activity::Shop)
            .map(|b| b.lot)
            .collect();
        visited
            .into_iter()
            .filter(|&lot| {
                self.building(lot)
                    .is_some_and(|(kind, _)| kind < u16::from(BuildingKind::SKYSCRAPER_FIRST))
            })
            .count() as u32
    }

    /// The percent of scored residents whose home has no factory within
    /// [`NOISE_RADIUS`] tiles. 100 when there are none.
    fn quiet_percent(&self) -> u32 {
        let lots_at: HashMap<(u16, u16), u32> = self
            .city
            .lots
            .iter()
            .map(|lot| ((lot.x, lot.z), lot.id))
            .collect();
        let mut noisy: HashMap<u32, bool> = HashMap::new();
        let (mut quiet, mut total) = (0u32, 0u32);
        for person in &self.people {
            let home = person.resident.home;
            let lot = &self.city.lots[home as usize];
            if !in_scope(&self.city, lot.district) {
                continue;
            }
            total += 1;
            let is_noisy = *noisy.entry(home).or_insert_with(|| {
                let near = |from: u16| from.saturating_sub(NOISE_RADIUS)..=from + NOISE_RADIUS;
                near(lot.x).any(|x| {
                    near(lot.z).any(|z| {
                        lots_at.get(&(x, z)).is_some_and(|&id| {
                            self.building(id).is_some_and(|(kind, _)| is_factory(kind))
                        })
                    })
                })
            });
            quiet += u32::from(!is_noisy);
        }
        (quiet * 100).checked_div(total).unwrap_or(100)
    }
}

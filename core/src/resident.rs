//! The people of a city: where they live, what they do and their day.
//!
//! Everything is drawn from the city's seed and the resident's index.

use crate::{
    City, Zone,
    names::resident_name,
    rng::{FNV_OFFSET, Rng, fnv1a},
    route::{Congestion, Trip, route},
    schedule::{Activity, Anchors, Archetype, Schedule},
};

#[cfg(test)]
mod tests;

/// People who share each home.
const PER_HOME: u32 = 2;
/// Vehicle kinds a resident may drive, numbered from 1; 0 is on foot.
pub const CAR_KINDS: u8 = 6;
/// How many candidates a workplace is the nearest of.
const CHOICES: usize = 3;
/// Ticks a tile of distance is guessed to take, with slack, for planning.
const TICKS_PER_TILE: u32 = 5;
/// Ticks of margin a resident leaves for parking and the walk to the door.
const MARGIN: u32 = 2;

/// The lots a city's residents live in and visit.
pub struct Places {
    homes: Vec<u32>,
    offices: Vec<u32>,
    factories: Vec<u32>,
    shops: Vec<u32>,
    parks: Vec<u32>,
    any: Vec<u32>,
}

impl Places {
    pub fn new(city: &City) -> Places {
        let mut p = Places {
            homes: Vec::new(),
            offices: Vec::new(),
            factories: Vec::new(),
            shops: Vec::new(),
            parks: Vec::new(),
            any: Vec::new(),
        };
        for lot in city.lots.iter().filter(|l| l.door().is_some()) {
            p.any.push(lot.id);
            match lot.zone {
                Zone::Suburban => p.homes.push(lot.id),
                Zone::Downtown => p.offices.push(lot.id),
                Zone::Commercial => {
                    p.offices.push(lot.id);
                    p.shops.push(lot.id);
                }
                Zone::Industrial => p.factories.push(lot.id),
                Zone::Park => p.parks.push(lot.id),
            }
        }
        p
    }

    /// How many residents the city has.
    pub fn population(&self) -> u32 {
        self.homes.len() as u32 * PER_HOME
    }
}

#[derive(Clone, Debug)]
pub struct Resident {
    pub id: u32,
    pub archetype: Archetype,
    pub home: u32,
    pub vehicle: u8,
    pub schedule: Schedule,
}

fn tiles(city: &City, a: u32, b: u32) -> u32 {
    let (a, b) = (&city.lots[a as usize], &city.lots[b as usize]);
    u32::from(a.x.abs_diff(b.x) + a.z.abs_diff(b.z))
}

/// The closest of a few random picks from `from`, other than `not`; any door if
/// `from` has nothing else.
fn pick(city: &City, rng: &mut Rng, from: &[u32], fallback: &[u32], near: u32, not: &[u32]) -> u32 {
    let pool = |list: &[u32]| list.iter().filter(|l| !not.contains(l)).count();
    let list = if pool(from) > 0 { from } else { fallback };
    let choices: Vec<u32> = list.iter().copied().filter(|l| !not.contains(l)).collect();
    (0..CHOICES)
        .map(|_| choices[rng.below(choices.len())])
        .min_by_key(|&l| (tiles(city, near, l), l))
        .expect("a city has doors")
}

impl Resident {
    /// Resident `index` of a city, where `index < places.population()`.
    pub fn new(city: &City, places: &Places, index: u32) -> Resident {
        let mut rng = Rng::for_index(&format!("{}/resident", city.seed), index);
        let archetype = Archetype::from_roll(rng.below(100));
        let home = places.homes[(index / PER_HOME) as usize % places.homes.len()];
        let work_list = match archetype {
            Archetype::Shift | Archetype::Night => &places.factories,
            Archetype::Shopkeeper => &places.shops,
            _ => &places.offices,
        };
        let work = pick(city, &mut rng, work_list, &places.any, home, &[home]);
        let shop = pick(
            city,
            &mut rng,
            &places.shops,
            &places.any,
            home,
            &[home, work],
        );
        let park = pick(
            city,
            &mut rng,
            &places.parks,
            &places.any,
            home,
            &[home, work, shop],
        );
        let anchors = Anchors {
            home,
            work,
            shop,
            park,
        };
        let schedule = Schedule::new(archetype, &mut rng, &anchors, |a, b| {
            tiles(city, a, b) * TICKS_PER_TILE + MARGIN
        });
        Resident {
            id: index,
            archetype,
            home,
            vehicle: 1 + rng.below(usize::from(CAR_KINDS)) as u8,
            schedule,
        }
    }

    pub fn name(&self, city: &City) -> String {
        resident_name(&city.seed, self.id)
    }

    /// The trip from block `block` to the next one, leaving at `depart`, or
    /// `None` if the roads do not connect them.
    pub fn trip(&self, city: &City, block: usize, depart: u32, cong: &Congestion) -> Option<Trip> {
        let blocks = &self.schedule.blocks;
        let from = city.lots[blocks[block].lot as usize].door()?;
        let to = city.lots[blocks[(block + 1) % blocks.len()].lot as usize].door()?;
        route(city, from, to, depart, cong)
    }

    /// Every trip of day `day`, in order. A trip leaves at its scheduled tick,
    /// or when the resident arrives if the last one ran late.
    pub fn day_trips(&self, city: &City, day: u32, cong: &Congestion) -> Option<Vec<Trip>> {
        let mut trips: Vec<Trip> = Vec::new();
        for block in 0..self.schedule.blocks.len() {
            let planned = self.schedule.leave_tick(block, day);
            let depart = trips.last().map_or(planned, |t| planned.max(t.arrive()));
            trips.push(self.trip(city, block, depart, cong)?);
        }
        Some(trips)
    }

    /// What the resident does in the block the trip leaves.
    pub fn activity(&self, block: usize) -> Activity {
        self.schedule.blocks[block].activity
    }
}

/// A hash of a resident's first day on empty roads: every leg, and the
/// position every few ticks along it. Native and WebAssembly builds agree.
pub fn day_hash(seed: &str, districts_per_side: u16, index: u32) -> Option<u64> {
    let city = City::generate(seed, districts_per_side).ok()?;
    let places = Places::new(&city);
    if index >= places.population() {
        return None;
    }
    let resident = Resident::new(&city, &places, index);
    let mut h = fnv1a(FNV_OFFSET, &[resident.archetype as u8, resident.vehicle]);
    for trip in resident.day_trips(&city, 0, &Congestion::FREE)? {
        h = fnv1a(h, &trip.depart.to_le_bytes());
        for leg in trip.legs() {
            h = fnv1a(h, &leg.segment.to_le_bytes());
            h = fnv1a(h, &[leg.speed]);
        }
        for tick in (trip.depart..=trip.arrive()).step_by(8) {
            let p = trip.position_at(&city, tick);
            for v in [p.segment, p.offset, p.x, p.z] {
                h = fnv1a(h, &v.to_le_bytes());
            }
        }
    }
    Some(h)
}

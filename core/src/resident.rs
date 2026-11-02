//! The people of a city: where they live, what they do and their day.
//!
//! Everything is drawn from the city's seed and the resident's index.

use crate::{
    City, Zone,
    names::resident_name,
    record::Leg,
    rng::{FNV_OFFSET, Rng, fnv1a},
    route::{Congestion, Mode, Trip, route, route_as},
    schedule::{Activity, Anchors, Archetype, Schedule, TICKS_PER_DAY},
};

#[cfg(test)]
mod tests;

/// People who share each home.
const PER_HOME: u32 = 6;
/// Vehicle kinds a resident may drive, numbered from 1; 0 is on foot.
pub const CAR_KINDS: u8 = 6;
/// How many candidates a workplace is the nearest of.
const CHOICES: usize = 3;
/// How many candidates a shop or park is the nearest of: errands stay close enough to walk.
const ERRAND_CHOICES: usize = 8;
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
    /// The connected piece of road each lot's door is on, by lot id.
    piece: Vec<u32>,
    /// Fixed from the homes the city has before its development area is set aside, so the area does not
    /// shrink the population.
    population: u32,
}

impl Places {
    pub fn new(city: &City) -> Places {
        Places::with_per_home(city, PER_HOME)
    }

    /// Like [`Places::new`] with `per_home` residents in each home, to load a city the way a
    /// bigger one would.
    pub fn with_per_home(city: &City, per_home: u32) -> Places {
        let mut p = Places {
            homes: Vec::new(),
            offices: Vec::new(),
            factories: Vec::new(),
            shops: Vec::new(),
            parks: Vec::new(),
            any: Vec::new(),
            piece: pieces(city),
            population: 0,
        };
        let mut full_homes = 0u32;
        for lot in city.lots.iter().filter(|l| l.door().is_some()) {
            full_homes += u32::from(lot.zone == Zone::Suburban);
            if city.development.binary_search(&lot.id).is_ok() {
                continue;
            }
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
        p.population = if p.homes.is_empty() {
            0
        } else {
            full_homes * per_home
        };
        p
    }

    /// How many residents the city has.
    pub fn population(&self) -> u32 {
        self.population
    }
}

/// Which connected piece of the road graph each lot's door is on; `u32::MAX`
/// for a lot with no door.
fn pieces(city: &City) -> Vec<u32> {
    let mut node_piece = vec![u32::MAX; city.nodes.len()];
    let mut next = 0;
    for start in 0..city.nodes.len() {
        if node_piece[start] != u32::MAX {
            continue;
        }
        node_piece[start] = next;
        let mut stack = vec![start as u32];
        while let Some(n) = stack.pop() {
            for &(m, _) in &city.adjacency[n as usize] {
                if node_piece[m as usize] == u32::MAX {
                    node_piece[m as usize] = next;
                    stack.push(m);
                }
            }
        }
        next += 1;
    }
    city.lots
        .iter()
        .map(|l| {
            l.door().map_or(u32::MAX, |d| {
                node_piece[city.segments[d.segment as usize].a as usize]
            })
        })
        .collect()
}

/// The lot a replanned trip leaves: none, it starts at a node.
pub const NO_LOT: u32 = u32::MAX;

/// A `trip` event's route matched to one of a resident's blocks.
struct Matched {
    /// Ticks the trip left after the block was due to.
    gap: u32,
    trip: Trip,
    block: usize,
    day: u32,
    from_lot: u32,
    to_lot: u32,
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
    u32::from(a.x.abs_diff(b.x)) + u32::from(a.z.abs_diff(b.z))
}

/// The closest of `CHOICES_OF` random picks from `from`, other than `not` and on
/// the road `near` is on; any such door if `from` has nothing else. `None` if
/// no door qualifies.
fn pick<const CHOICES_OF: usize>(
    city: &City,
    places: &Places,
    rng: &mut Rng,
    from: &[u32],
    fallback: &[u32],
    near: u32,
    not: &[u32],
) -> Option<u32> {
    let piece = places.piece[near as usize];
    let eligible = |list: &[u32]| -> Vec<u32> {
        list.iter()
            .copied()
            .filter(|l| !not.contains(l) && places.piece[*l as usize] == piece)
            .collect()
    };
    let mut choices = eligible(from);
    if choices.is_empty() {
        choices = eligible(fallback);
    }
    if choices.is_empty() {
        return None;
    }
    (0..CHOICES_OF)
        .map(|_| choices[rng.below(choices.len())])
        .min_by_key(|&l| (tiles(city, near, l), l))
}

impl Resident {
    /// Resident `index` of a city, where `index < places.population()`, or
    /// `None` if the roads leave them no workplace, shop or park to reach.
    pub fn new(city: &City, places: &Places, index: u32) -> Option<Resident> {
        let mut rng = Rng::for_index(&format!("{}/resident", city.seed), index);
        let archetype = Archetype::from_roll(rng.below(100));
        let home = places.homes[(u64::from(index) * places.homes.len() as u64
            / u64::from(places.population.max(1))) as usize
            % places.homes.len()];
        let work_list = match archetype {
            Archetype::Shift | Archetype::Night => &places.factories,
            Archetype::Shopkeeper => &places.shops,
            _ => &places.offices,
        };
        let work = pick::<CHOICES>(
            city,
            places,
            &mut rng,
            work_list,
            &places.any,
            home,
            &[home],
        )?;
        let shop = pick::<ERRAND_CHOICES>(
            city,
            places,
            &mut rng,
            &places.shops,
            &places.any,
            home,
            &[home, work],
        )?;
        let park = pick::<ERRAND_CHOICES>(
            city,
            places,
            &mut rng,
            &places.parks,
            &places.any,
            home,
            &[home, work, shop],
        )?;
        let anchors = Anchors {
            home,
            work,
            shop,
            park,
        };
        let schedule = Schedule::new(archetype, &mut rng, &anchors, |a, b| {
            tiles(city, a, b) * TICKS_PER_TILE + MARGIN
        });
        Some(Resident {
            id: index,
            archetype,
            home,
            vehicle: 1 + rng.below(usize::from(CAR_KINDS)) as u8,
            schedule,
        })
    }

    pub fn name(&self, city: &City) -> String {
        resident_name(&city.seed, self.id)
    }

    /// The resident as JSON for the page's card: name, archetype, home lot, vehicle kind and the day's
    /// blocks in order. Every string is lower-case ASCII or a name from the built-in lists, so none needs escaping.
    pub fn to_json(&self, city: &City) -> String {
        let blocks: Vec<String> = self
            .schedule
            .blocks
            .iter()
            .map(|b| {
                format!(
                    "{{\"activity\":\"{}\",\"lot\":{},\"leave\":{}}}",
                    b.activity.name(),
                    b.lot,
                    b.leave
                )
            })
            .collect();
        format!(
            "{{\"id\":{},\"name\":\"{}\",\"archetype\":\"{}\",\"home\":{},\"vehicle\":{},\"blocks\":[{}]}}",
            self.id,
            self.name(city),
            self.archetype.name(),
            self.home,
            self.vehicle,
            blocks.join(",")
        )
    }

    /// The trip from block `block` to the next one, leaving at `depart`, or
    /// `None` if the roads do not connect them.
    pub fn trip(&self, city: &City, block: usize, depart: u32, cong: &Congestion) -> Option<Trip> {
        let blocks = &self.schedule.blocks;
        let from = city.lots[blocks[block].lot as usize].door()?;
        let to = city.lots[blocks[(block + 1) % blocks.len()].lot as usize].door()?;
        route(city, from, to, depart, cong)
    }

    /// The trip from block `block` to the next one, sent from `node` in `mode`
    /// at `depart`: what a resident gets when a road on their way is removed.
    pub fn replan(
        &self,
        city: &City,
        block: usize,
        node: u32,
        depart: u32,
        cong: &Congestion,
        mode: Mode,
    ) -> Option<Trip> {
        let blocks = &self.schedule.blocks;
        let to = city.lots[blocks[(block + 1) % blocks.len()].lot as usize].door()?;
        route_as(city, city.node_door(node), to, depart, cong, mode)
    }

    /// The trip a `replan` event describes: the block whose next lot the legs
    /// reach from `node`, and if more than one does, the one that was due to
    /// leave most recently before `depart`. Like
    /// [`Resident::trip_in_progress`], with the block and day. `None` if no
    /// block's trip has these legs.
    pub fn replan_in_progress(
        &self,
        city: &City,
        node: u32,
        depart: u32,
        legs: &[Leg],
        mode: Mode,
    ) -> Option<(Trip, usize, u32)> {
        let found = self.match_route(city, Some(node), depart, legs, mode)?;
        Some((found.trip, found.block, found.day))
    }

    /// Like [`Resident::replan_in_progress`], with the lot the trip enters.
    pub fn replan_between(
        &self,
        city: &City,
        node: u32,
        depart: u32,
        legs: &[Leg],
        mode: Mode,
    ) -> Option<(Trip, u32)> {
        let found = self.match_route(city, Some(node), depart, legs, mode)?;
        Some((found.trip, found.to_lot))
    }

    /// The trip a `trip` event for this resident describes: the block whose
    /// doors the legs join, and if more than one does, the one that was due
    /// to leave most recently before `depart`. `None` if no block's trip has
    /// these legs.
    pub fn trip_from_route(
        &self,
        city: &City,
        depart: u32,
        legs: &[Leg],
        mode: Mode,
    ) -> Option<Trip> {
        self.trip_between_lots(city, depart, legs, mode)
            .map(|(trip, _, _)| trip)
    }

    /// Like [`Resident::trip_from_route`], with the lots the trip leaves and enters.
    pub fn trip_between_lots(
        &self,
        city: &City,
        depart: u32,
        legs: &[Leg],
        mode: Mode,
    ) -> Option<(Trip, u32, u32)> {
        let found = self.match_route(city, None, depart, legs, mode)?;
        Some((found.trip, found.from_lot, found.to_lot))
    }

    /// Like [`Resident::trip_from_route`], with the schedule block the trip
    /// leaves and the day that block's leave tick is on: what a sim that
    /// restarts needs to carry on from a trip already under way.
    pub fn trip_in_progress(
        &self,
        city: &City,
        depart: u32,
        legs: &[Leg],
        mode: Mode,
    ) -> Option<(Trip, usize, u32)> {
        let found = self.match_route(city, None, depart, legs, mode)?;
        Some((found.trip, found.block, found.day))
    }

    /// `from` is the node a replanned trip starts at, or `None` for a trip that
    /// leaves a block's lot by its door.
    fn match_route(
        &self,
        city: &City,
        from: Option<u32>,
        depart: u32,
        legs: &[Leg],
        mode: Mode,
    ) -> Option<Matched> {
        let blocks = &self.schedule.blocks;
        let today = depart / TICKS_PER_DAY;
        (0..blocks.len())
            .filter_map(|block| {
                let (from_lot, to_lot) =
                    (blocks[block].lot, blocks[(block + 1) % blocks.len()].lot);
                let to = city.lots[to_lot as usize].door()?;
                let door = match from {
                    Some(node) => city.node_door(node),
                    None => city.lots[from_lot as usize].door()?,
                };
                let trip = Trip::from_route(city, door, to, depart, legs, mode)?;
                let due = [today.saturating_sub(1), today]
                    .into_iter()
                    .map(|d| (self.schedule.leave_tick(block, d), d))
                    .filter(|&(t, _)| t <= depart)
                    .max();
                Some(Matched {
                    gap: depart - due.map_or(0, |(t, _)| t),
                    trip,
                    block,
                    day: due.map_or(today, |(_, d)| d),
                    from_lot: if from.is_some() { NO_LOT } else { from_lot },
                    to_lot,
                })
            })
            .min_by_key(|m| m.gap)
    }

    /// Every trip of day `day`, in order. A trip leaves at its scheduled tick,
    /// or when the resident arrives if the last one ran late. `free_at` is the
    /// tick the previous day's last trip ended, so a late night carries over.
    pub fn day_trips(
        &self,
        city: &City,
        day: u32,
        cong: &Congestion,
        free_at: u32,
    ) -> Option<Vec<Trip>> {
        let mut trips: Vec<Trip> = Vec::new();
        for block in 0..self.schedule.blocks.len() {
            let planned = self.schedule.leave_tick(block, day);
            let busy_until = trips.last().map_or(free_at, Trip::arrive);
            let depart = planned.max(busy_until);
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
    let resident = Resident::new(&city, &places, index)?;
    let mut h = fnv1a(FNV_OFFSET, &[resident.archetype as u8, resident.vehicle]);
    for trip in resident.day_trips(&city, 0, &Congestion::FREE, 0)? {
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

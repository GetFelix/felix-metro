//! Routes on the road graph and the trips that follow them.
//!
//! Costs are milliseconds of travel at the speed a trip would drive, in
//! integers, so native and WebAssembly builds find the same path. Last tick's
//! segment counts slow a segment down, and the same slowdown sets the speed
//! the trip drives it at, so the route chosen is the route taken.

use std::{cmp::Reverse, collections::BinaryHeap};

use crate::{City, Door, record::Leg};

#[cfg(test)]
mod tests;

/// Ticks a second of real time at normal speed; segment speeds are per real second.
const TICKS_PER_SECOND: u64 = 4;
/// A route this short, in thousandths of a tile, is walked: far enough that errands put people on the pavements.
pub const WALK_MAX: u32 = 8000;
/// Walking speed in thousandths of a tile a second.
const WALK_SPEED: u32 = 300;
/// A jammed segment never drives slower than this percentage of its speed.
const MIN_PERCENT: u32 = 20;
/// Cars a tile of road holds before it slows down.
const CARS_PER_TILE: u32 = 3;
/// The fastest road, in milliseconds a tile, rounded down so the search
/// heuristic never overestimates.
const FASTEST_MS_PER_TILE: u64 = 666;

/// How many vehicles were on each segment last tick, by segment id.
#[derive(Clone, Copy, Debug)]
pub struct Congestion<'a>(&'a [u16]);

impl<'a> Congestion<'a> {
    /// An empty city: every segment at full speed.
    pub const FREE: Congestion<'static> = Congestion(&[]);

    pub fn new(counts: &'a [u16]) -> Self {
        Self(counts)
    }

    fn percent(&self, segment: u32, length: u16) -> u32 {
        let count = u32::from(self.0.get(segment as usize).copied().unwrap_or(0));
        let room = CARS_PER_TILE * u32::from(length);
        (100 * room / (room + count)).max(MIN_PERCENT)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Walk,
    Drive,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TripLeg {
    segment: u32,
    /// Thousandths of a tile from the segment's first node.
    from: u32,
    to: u32,
    /// Percentage of the segment class's speed.
    speed: u8,
    /// The tick the leg is finished.
    end: u32,
}

/// Where a trip is at a tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Position {
    pub leg: u16,
    pub segment: u32,
    /// Thousandths of a tile from the segment's first node.
    pub offset: u32,
    /// Thousandths of a tile from the city's north-west corner.
    pub x: u32,
    pub z: u32,
}

/// A route and the speed along it. Always at least one leg.
#[derive(Clone, Debug)]
pub struct Trip {
    pub mode: Mode,
    pub depart: u32,
    legs: Vec<TripLeg>,
}

impl Trip {
    /// The trip a `trip` event describes: the route `legs` from door `from` to
    /// door `to`, leaving at `depart`. The event carries segments and speeds
    /// but not the ends of the first and last leg, which are the doors, or the
    /// direction each leg is driven, which follows from the segments joining
    /// up. `None` when the legs do not form a route between the doors.
    pub fn from_route(
        city: &City,
        from: Door,
        to: Door,
        depart: u32,
        legs: &[Leg],
        mode: Mode,
    ) -> Option<Trip> {
        let spans = rebuild_spans(city, from, to, legs)?;
        let mut tick = depart;
        let legs = spans
            .into_iter()
            .zip(legs)
            .map(|((segment, from, to), leg)| {
                let seg = &city.segments[segment as usize];
                tick += leg_ticks(seg.speed, u32::from(leg.speed), from.abs_diff(to));
                TripLeg {
                    segment,
                    from,
                    to,
                    speed: leg.speed,
                    end: tick,
                }
            })
            .collect();
        Some(Trip { mode, depart, legs })
    }

    /// The tick the trip ends.
    pub fn arrive(&self) -> u32 {
        self.legs.last().map_or(self.depart, |l| l.end)
    }

    /// The route as the `trip` event carries it.
    pub fn legs(&self) -> Vec<Leg> {
        self.legs
            .iter()
            .map(|l| Leg {
                segment: l.segment,
                speed: l.speed,
            })
            .collect()
    }

    /// Thousandths of a tile covered.
    pub fn length(&self) -> u32 {
        self.legs.iter().map(|l| l.from.abs_diff(l.to)).sum()
    }

    /// Thousandths of a tile covered by `tick`. Never decreases with the tick.
    pub fn distance_at(&self, tick: u32) -> u32 {
        let mut done = 0;
        let mut start = self.depart;
        for leg in &self.legs {
            let len = leg.from.abs_diff(leg.to);
            if tick >= leg.end {
                done += len;
                start = leg.end;
            } else {
                return done + interpolate(len, tick.saturating_sub(start), leg.end - start);
            }
        }
        done
    }

    /// The leg the trip is on at `tick` and how far along it is, in
    /// thousandths. Held at the first leg's start before the trip leaves and
    /// at the last leg's end after it ends.
    pub fn leg_progress(&self, tick: u32) -> (usize, u16) {
        let mut start = self.depart;
        for (i, leg) in self.legs.iter().enumerate() {
            if tick < leg.end || i + 1 == self.legs.len() {
                let span = leg.end - start;
                let done = interpolate(1000, tick.saturating_sub(start), span);
                return (i, done as u16);
            }
            start = leg.end;
        }
        unreachable!("a trip has a leg")
    }

    /// The position at `tick`, held at the first door before the trip leaves
    /// and at the last one after it ends.
    pub fn position_at(&self, city: &City, tick: u32) -> Position {
        let mut start = self.depart;
        for (i, leg) in self.legs.iter().enumerate() {
            if tick < leg.end || i + 1 == self.legs.len() {
                let len = leg.from.abs_diff(leg.to);
                let moved = interpolate(len, tick.saturating_sub(start), leg.end - start);
                let offset = if leg.to >= leg.from {
                    leg.from + moved
                } else {
                    leg.from - moved
                };
                let (x, z) = point(city, leg.segment, offset);
                return Position {
                    leg: i as u16,
                    segment: leg.segment,
                    offset,
                    x,
                    z,
                };
            }
            start = leg.end;
        }
        unreachable!("a trip has a leg")
    }
}

/// `len * elapsed / span`, capped at `len`.
fn interpolate(len: u32, elapsed: u32, span: u32) -> u32 {
    (u64::from(len) * u64::from(elapsed.min(span)) / u64::from(span.max(1))) as u32
}

pub(crate) fn point(city: &City, segment: u32, offset: u32) -> (u32, u32) {
    let seg = &city.segments[segment as usize];
    let (a, b) = (city.nodes[seg.a as usize], city.nodes[seg.b as usize]);
    let at = |from: u16, to: u16| {
        let base = u32::from(from) * 1000;
        if to > from { base + offset } else { base }
    };
    (at(a.0, b.0), at(a.1, b.1))
}

/// Milliseconds to cover `milli` of a segment. Walking pace is the same on
/// every road, so a walker's cheapest path is its shortest.
fn leg_ms(city: &City, segment: u32, milli: u32, cong: &Congestion, mode: Mode) -> u64 {
    let seg = &city.segments[segment as usize];
    match mode {
        Mode::Walk => u64::from(milli) * 1000 / u64::from(WALK_SPEED),
        Mode::Drive => {
            let percent = cong.percent(segment, seg.length);
            u64::from(milli) * 100_000 / (u64::from(seg.speed) * u64::from(percent))
        }
    }
}

fn leg_ticks(speed: u16, percent: u32, milli: u32) -> u32 {
    let per_second = u64::from(speed) * u64::from(percent);
    ((u64::from(milli) * TICKS_PER_SECOND * 100).div_ceil(per_second) as u32).max(1)
}

/// The nodes a door's segment can be left or entered by, with the
/// thousandths of a tile to each.
fn ends(city: &City, door: Door) -> [(u32, u32); 2] {
    let seg = &city.segments[door.segment as usize];
    let at = u32::from(door.offset) * 1000;
    [(seg.a, at), (seg.b, u32::from(seg.length) * 1000 - at)]
}

fn manhattan(city: &City, a: u32, b: u32) -> u64 {
    let (a, b) = (city.nodes[a as usize], city.nodes[b as usize]);
    u64::from(a.0.abs_diff(b.0) + a.1.abs_diff(b.1))
}

/// A segment and the thousandths of a tile covered along it, from and to.
type Span = (u32, u32, u32);

/// A path as the segments to take from a node and the node they start at.
struct Path {
    first: u32,
    steps: Vec<(u32, u32)>,
    last: u32,
}

/// The cheapest path for `mode` between two doors' segments, or `None` if they
/// are not connected. `guide` turns on the A* heuristic; off it is plain
/// Dijkstra, which the tests compare against.
fn search(
    city: &City,
    from: Door,
    to: Door,
    cong: &Congestion,
    mode: Mode,
    guide: bool,
) -> Option<(u64, Path)> {
    let ms_per_tile = match mode {
        Mode::Walk => 1_000_000 / u64::from(WALK_SPEED),
        Mode::Drive => FASTEST_MS_PER_TILE,
    };
    let goals = ends(city, to);
    let extra = |n: u32| goals.iter().find(|g| g.0 == n).map(|g| g.1);
    let h = |n: u32| {
        if !guide {
            return 0;
        }
        goals
            .iter()
            .map(|g| manhattan(city, n, g.0) * ms_per_tile)
            .min()
            .unwrap_or(0)
    };
    let mut g = vec![u64::MAX; city.nodes.len()];
    let mut prev: Vec<Option<(u32, u32)>> = vec![None; city.nodes.len()];
    let mut heap = BinaryHeap::new();
    for (node, milli) in ends(city, from) {
        let cost = leg_ms(city, from.segment, milli, cong, mode);
        if cost < g[node as usize] {
            g[node as usize] = cost;
            heap.push(Reverse((cost + h(node), node)));
        }
    }
    let mut best = (u64::MAX, u32::MAX);
    while let Some(Reverse((f, n))) = heap.pop() {
        if f >= best.0 {
            break;
        }
        if f > g[n as usize] + h(n) {
            continue;
        }
        if let Some(milli) = extra(n) {
            let total = g[n as usize] + leg_ms(city, to.segment, milli, cong, mode);
            if total < best.0 {
                best = (total, n);
            }
        }
        for &(m, segment) in &city.adjacency[n as usize] {
            let seg = &city.segments[segment as usize];
            let cost =
                g[n as usize] + leg_ms(city, segment, u32::from(seg.length) * 1000, cong, mode);
            if cost < g[m as usize] {
                g[m as usize] = cost;
                prev[m as usize] = Some((n, segment));
                heap.push(Reverse((cost + h(m), m)));
            }
        }
    }
    if best.1 == u32::MAX {
        return None;
    }
    let mut steps = Vec::new();
    let mut at = best.1;
    while let Some((p, segment)) = prev[at as usize] {
        steps.push((p, segment));
        at = p;
    }
    steps.reverse();
    Some((
        best.0,
        Path {
            first: at,
            steps,
            last: best.1,
        },
    ))
}

/// The segments to follow for `mode`.
/// Zero-length spans, from a door at a node, are dropped; one span is always kept.
fn spans(city: &City, from: Door, to: Door, cong: &Congestion, mode: Mode) -> Option<Vec<Span>> {
    let mut spans: Vec<Span> = Vec::new();
    if from.segment == to.segment {
        // Same-segment trips go straight; going around a jam is never weighed.
        spans.push((
            from.segment,
            u32::from(from.offset) * 1000,
            u32::from(to.offset) * 1000,
        ));
    } else {
        let (_, path) = search(city, from, to, cong, mode, true)?;
        let seg_len = |s: u32| u32::from(city.segments[s as usize].length) * 1000;
        let leave = |s: u32, node: u32| {
            if city.segments[s as usize].a == node {
                0
            } else {
                seg_len(s)
            }
        };
        spans.push((
            from.segment,
            u32::from(from.offset) * 1000,
            leave(from.segment, path.first),
        ));
        for &(node, s) in &path.steps {
            let seg = &city.segments[s as usize];
            spans.push(if seg.a == node {
                (s, 0, seg_len(s))
            } else {
                (s, seg_len(s), 0)
            });
        }
        spans.push((
            to.segment,
            leave(to.segment, path.last),
            u32::from(to.offset) * 1000,
        ));
    }
    let first = spans[0];
    spans.retain(|s| s.1 != s.2);
    if spans.is_empty() {
        spans.push(first);
    }
    Some(spans)
}

/// A trip from one door to another departing at `depart`, or `None` if the
/// roads do not connect them. If the shortest way is no longer than
/// [`WALK_MAX`] it is walked; otherwise the trip drives the cheapest route
/// under `cong`.
pub fn route(city: &City, from: Door, to: Door, depart: u32, cong: &Congestion) -> Option<Trip> {
    let on_foot = spans(city, from, to, cong, Mode::Walk)?;
    let (mode, spans) = if span_length(&on_foot) <= WALK_MAX {
        (Mode::Walk, on_foot)
    } else {
        (Mode::Drive, spans(city, from, to, cong, Mode::Drive)?)
    };
    let mut tick = depart;
    let legs = spans
        .into_iter()
        .map(|(segment, from, to)| {
            let seg = &city.segments[segment as usize];
            let percent = match mode {
                Mode::Walk => (WALK_SPEED * 100 / u32::from(seg.speed)).max(1),
                Mode::Drive => cong.percent(segment, seg.length),
            };
            tick += leg_ticks(seg.speed, percent, from.abs_diff(to));
            TripLeg {
                segment,
                from,
                to,
                speed: percent as u8,
                end: tick,
            }
        })
        .collect();
    Some(Trip { mode, depart, legs })
}

/// The spans [`route`] made `legs` from, undone: `spans` drops a span of no
/// length at either end, so a leg is the door's segment, the destination's, or
/// a whole segment between them.
fn rebuild_spans(city: &City, from: Door, to: Door, legs: &[Leg]) -> Option<Vec<Span>> {
    let segs: Vec<u32> = legs.iter().map(|l| l.segment).collect();
    let (&first, &last) = (segs.first()?, segs.last()?);
    if segs.iter().any(|&s| s as usize >= city.segments.len()) {
        return None;
    }
    let len = |s: u32| u32::from(city.segments[s as usize].length) * 1000;
    let ends = |s: u32| {
        let g = &city.segments[s as usize];
        [g.a, g.b]
    };
    // The node a segment is left or entered by at `offset`, if it is at one.
    let node_at = |d: Door| -> Option<u32> {
        let g = &city.segments[d.segment as usize];
        match u32::from(d.offset) * 1000 {
            0 => Some(g.a),
            o if o == len(d.segment) => Some(g.b),
            _ => None,
        }
    };
    let leave = |s: u32, node: u32| {
        if city.segments[s as usize].a == node {
            0
        } else {
            len(s)
        }
    };
    let shared = |a: u32, b: u32| ends(a).into_iter().find(|n| ends(b).contains(n));
    let (fo, to_off) = (u32::from(from.offset) * 1000, u32::from(to.offset) * 1000);
    if from.segment == to.segment {
        return (segs.len() == 1 && first == from.segment).then(|| vec![(first, fo, to_off)]);
    }
    let head = first == from.segment;
    let tail = last == to.segment && (segs.len() > 1 || !head);
    let steps = &segs[usize::from(head)..segs.len() - usize::from(tail)];
    // The node the first span is left by.
    let start = match steps {
        [] => match (head, tail) {
            (true, true) => shared(first, last)?,
            (true, false) => node_at(to)?,
            (false, true) => node_at(from)?,
            (false, false) => return None,
        },
        [next, ..] if head => shared(first, *next)?,
        _ => node_at(from)?,
    };
    let mut spans: Vec<Span> = Vec::new();
    if head {
        spans.push((first, fo, leave(first, start)));
    } else if node_at(from)? != start {
        return None;
    }
    let mut at = start;
    for &s in steps {
        let [a, b] = ends(s);
        let (enter, out) = if a == at {
            (0, len(s))
        } else if b == at {
            (len(s), 0)
        } else {
            return None;
        };
        spans.push((s, enter, out));
        at = if a == at { b } else { a };
    }
    if tail {
        if !ends(last).contains(&at) {
            return None;
        }
        spans.push((last, leave(last, at), to_off));
    } else if node_at(to)? != at {
        return None;
    }
    // `spans` kept one span even when every one had no length.
    (spans.len() == segs.len()).then_some(spans)
}

fn span_length(spans: &[Span]) -> u32 {
    spans.iter().map(|s| s.1.abs_diff(s.2)).sum()
}

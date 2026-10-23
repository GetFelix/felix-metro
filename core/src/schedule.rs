//! A resident's day: where they are and when they leave for the next place.
//!
//! A day is a cycle of blocks. Block `i` ends at `leave` (a tick of the day)
//! with a trip to block `i + 1`, and the last block's trip returns to the
//! first, so the day closes. A night worker's first block is their workplace,
//! because they are still there at midnight.

use crate::rng::Rng;

#[cfg(test)]
mod tests;

/// 15 seconds of city time a tick.
pub const TICKS_PER_DAY: u32 = 5760;
pub const TICKS_PER_HOUR: u32 = 240;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Archetype {
    Office,
    Shift,
    Shopkeeper,
    Student,
    Retiree,
    Night,
}

impl Archetype {
    pub const ALL: [Archetype; 6] = [
        Archetype::Office,
        Archetype::Shift,
        Archetype::Shopkeeper,
        Archetype::Student,
        Archetype::Retiree,
        Archetype::Night,
    ];

    /// Picks from a roll of 0 to 99 by population share.
    pub(crate) fn from_roll(roll: usize) -> Archetype {
        match roll {
            0..35 => Archetype::Office,
            35..50 => Archetype::Shift,
            50..60 => Archetype::Shopkeeper,
            60..75 => Archetype::Student,
            75..90 => Archetype::Retiree,
            _ => Archetype::Night,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Activity {
    Home,
    Work,
    School,
    Shop,
    Leisure,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Block {
    pub activity: Activity,
    pub lot: u32,
    /// The tick of the day they set off for the next block.
    pub leave: u32,
}

/// The places an archetype draws on.
pub(crate) struct Anchors {
    pub home: u32,
    pub work: u32,
    pub shop: u32,
    pub park: u32,
}

#[derive(Clone, Debug)]
pub struct Schedule {
    pub blocks: Vec<Block>,
}

fn between(rng: &mut Rng, lo: u32, hi: u32) -> u32 {
    lo + rng.below((hi - lo) as usize) as u32
}

impl Schedule {
    /// `travel` estimates the ticks between two lots; people leave early
    /// enough to arrive at their usual time.
    pub(crate) fn new(
        archetype: Archetype,
        rng: &mut Rng,
        a: &Anchors,
        travel: impl Fn(u32, u32) -> u32,
    ) -> Schedule {
        let h = TICKS_PER_HOUR;
        let mut blocks: Vec<Block> = Vec::new();
        // Leave `lot` at `leave`, or soon after the previous leave if that is later.
        let mut push = |activity, lot, leave: u32| {
            let floor = blocks.last().map_or(0, |b| b.leave + 1);
            blocks.push(Block {
                activity,
                lot,
                leave: leave.max(floor).min(TICKS_PER_DAY - 1),
            });
        };
        match archetype {
            Archetype::Office | Archetype::Shopkeeper | Archetype::Shift => {
                let (arrive, dwell) = match archetype {
                    Archetype::Office => {
                        (between(rng, h * 15 / 2, h * 9), between(rng, h * 8, h * 9))
                    }
                    Archetype::Shift => (between(rng, h * 11 / 2, h * 13 / 2), h * 8),
                    _ => (between(rng, h * 8, h * 9), between(rng, h * 9, h * 21 / 2)),
                };
                push(
                    Activity::Home,
                    a.home,
                    arrive.saturating_sub(travel(a.home, a.work)),
                );
                let out = arrive + dwell;
                push(Activity::Work, a.work, out);
                if archetype == Archetype::Office && rng.below(10) < 4 {
                    let stay = between(rng, h * 2 / 3, h * 3 / 2);
                    push(Activity::Shop, a.shop, out + travel(a.work, a.shop) + stay);
                }
            }
            Archetype::Student => {
                let arrive = between(rng, h * 15 / 2, h * 33 / 4);
                push(
                    Activity::Home,
                    a.home,
                    arrive.saturating_sub(travel(a.home, a.work)),
                );
                let out = between(rng, h * 29 / 2, h * 31 / 2);
                push(Activity::School, a.work, out);
                let stay = between(rng, h, h * 5 / 2);
                push(
                    Activity::Leisure,
                    a.park,
                    out + travel(a.work, a.park) + stay,
                );
            }
            Archetype::Retiree => {
                let out = between(rng, h * 9, h * 21 / 2);
                push(Activity::Home, a.home, out);
                let shop_out = out + travel(a.home, a.shop) + between(rng, h * 2 / 3, h * 3 / 2);
                push(Activity::Shop, a.shop, shop_out);
                let stay = between(rng, h, h * 5 / 2);
                push(
                    Activity::Leisure,
                    a.park,
                    shop_out + travel(a.shop, a.park) + stay,
                );
            }
            Archetype::Night => {
                push(Activity::Work, a.work, between(rng, h * 11 / 2, h * 13 / 2));
                let back = between(rng, h * 21, h * 22);
                push(
                    Activity::Home,
                    a.home,
                    back.saturating_sub(travel(a.home, a.work)),
                );
            }
        }
        Schedule { blocks }
    }

    /// The tick a block's trip should set off, on day `day`.
    pub fn leave_tick(&self, block: usize, day: u32) -> u32 {
        day * TICKS_PER_DAY + self.blocks[block].leave
    }
}

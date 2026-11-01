//! The city's account: what a day earns and costs, and what building costs.
//!
//! The account is kept per district (each district's share) so a district's
//! records can be followed on their own. The city's balance is the sum.
//! The numbers are placeholders until the economy has been played.

use felix_metro_core::{BuildingKind, City, Zone};

use super::World;

#[cfg(test)]
mod tests;

/// What the city starts with, split evenly over the districts.
pub(crate) const START_FUNDS: i64 = 100_000;

/// Tax each resident pays per city day, to the district they live in.
const TAX_PER_RESIDENT: u64 = 4;
/// Tax each shop, office and factory pays per city day.
const TAX_PER_BUSINESS: u64 = 30;
/// Upkeep of a tile of road per city day.
const UPKEEP_PER_ROAD_TILE: u64 = 1;
/// Upkeep of a park per city day.
const UPKEEP_PER_PARK: u64 = 20;
/// The price of a demolition.
pub(crate) const DEMOLISH_COST: u64 = 100;

/// A district's share of the opening funds. The odd units go to district 0.
pub(crate) fn opening_share(districts: usize, district: usize) -> i64 {
    let n = districts as i64;
    START_FUNDS / n + if district == 0 { START_FUNDS % n } else { 0 }
}

/// The price of putting a building of `kind` on a lot.
pub(crate) fn build_cost(kind: u16) -> u64 {
    let kind = u8::try_from(kind).unwrap_or(u8::MAX);
    match kind {
        BuildingKind::HOUSE_FIRST..BuildingKind::FACTORY_FIRST => 300,
        BuildingKind::SKYSCRAPER_FIRST..BuildingKind::HOUSE_FIRST => 1500,
        BuildingKind::FACTORY_FIRST..BuildingKind::TREE_FIRST => 800,
        _ => 500,
    }
}

/// True for the kinds that pay business tax: shops, offices and factories.
fn is_business(kind: u16) -> bool {
    kind < u16::from(BuildingKind::HOUSE_FIRST)
        || (u16::from(BuildingKind::FACTORY_FIRST)..u16::from(BuildingKind::TREE_FIRST))
            .contains(&kind)
}

/// What stays the same all game, by district: road tiles and parks to keep up.
pub(super) fn upkeep_base(city: &City) -> Vec<u64> {
    let side = u32::from(city.districts_per_side);
    let mut base = vec![0u64; city.districts.len()];
    for segment in &city.segments {
        let (x, z) = city.nodes[segment.a as usize];
        let column = (u32::from(x) / 12).min(side - 1);
        let row = (u32::from(z) / 12).min(side - 1);
        base[(row * side + column) as usize] += u64::from(segment.length) * UPKEEP_PER_ROAD_TILE;
    }
    for lot in &city.lots {
        if lot.zone == Zone::Park {
            base[usize::from(lot.district)] += UPKEEP_PER_PARK;
        }
    }
    base
}

impl World {
    /// The city's balance: the sum of the districts' shares.
    pub(crate) fn funds(&self) -> i64 {
        self.accounts.iter().sum()
    }

    /// Sets the city's balance, all in district 0.
    #[cfg(test)]
    pub(crate) fn set_funds(&mut self, amount: i64) {
        self.accounts.fill(0);
        self.accounts[0] = amount;
    }

    /// Whether a city day ends with this tick.
    pub(super) fn day_ends(tick: u32) -> bool {
        tick > 0 && tick.is_multiple_of(felix_metro_core::TICKS_PER_DAY)
    }

    /// What each district earned and spent over the day that just ended, and
    /// books it into the accounts: `(earned, spent)` by district.
    pub(super) fn close_day(&mut self) -> Vec<(u64, u64)> {
        let mut day: Vec<(u64, u64)> = self.upkeep.iter().map(|&u| (0, u)).collect();
        for person in &self.people {
            let home = person.resident.schedule.blocks[0].lot;
            day[usize::from(self.city.lots[home as usize].district)].0 += TAX_PER_RESIDENT;
        }
        for lot in &self.city.lots {
            if let Some((kind, _)) = self.building(lot.id)
                && is_business(kind)
            {
                day[usize::from(lot.district)].0 += TAX_PER_BUSINESS;
            }
        }
        for (account, (earned, spent)) in self.accounts.iter_mut().zip(&day) {
            *account += *earned as i64 - *spent as i64;
        }
        day
    }
}

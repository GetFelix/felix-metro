//! Builders' roads: what `place road` and `remove road` do to the world, and
//! what the world does about it.
//!
//! The rules about the land are `City::road_tiles`'s; the ones that need the
//! world are here: the lots residents use, the buildings, and the funds.

use felix_metro_core::RoadError;
use felix_metro_core::record::{
    Event, LEDGER_BUILD, LEDGER_DEMOLISH, REFUSED_IN_USE, REFUSED_NO_FUNDS, REFUSED_NOT_BUILT,
    REFUSED_OCCUPIED, REFUSED_UNKNOWN, RESULT_APPLIED, ROAD_ADDED, ROAD_REMOVED,
};

use super::{Applied, World, economy, is_empty};

#[cfg(test)]
pub(crate) mod tests;

impl World {
    /// The district a node is in, by its tile.
    pub(super) fn node_district(&self, node: u32) -> Option<u16> {
        let &(x, z) = self.city.nodes.get(node as usize)?;
        let side = u32::from(self.city.districts_per_side);
        let column = (u32::from(x) / 12).min(side - 1);
        let row = (u32::from(z) / 12).min(side - 1);
        Some((row * side + column) as u16)
    }

    pub(super) fn place_road(&mut self, a: u32, b: u32) -> Applied {
        let district = self.node_district(a).unwrap_or(0);
        let tiles = match self.city.road_tiles(a, b) {
            Ok(tiles) => tiles,
            Err(err) => return Applied::refused(district, err.refusal()),
        };
        // The same rules as a building: a lot residents go to, or one with something on it, is not bare ground.
        for &(x, z) in &tiles {
            let lot = self
                .city
                .lot_at(x, z)
                .expect("road_tiles found a lot here")
                .id;
            if self.in_use.contains(&lot) {
                return Applied::refused(district, REFUSED_IN_USE);
            }
            if self.building(lot).is_some_and(|(kind, _)| !is_empty(kind)) {
                return Applied::refused(district, REFUSED_OCCUPIED);
            }
        }
        let cost = economy::ROAD_COST_PER_TILE * tiles.len() as u64;
        if self.funds() < cost as i64 {
            return Applied::refused(district, REFUSED_NO_FUNDS);
        }
        let segment = self.city.add_road(a, b).expect("road_tiles allowed it");
        self.roads_changed();
        self.accounts[usize::from(district)] -= cost as i64;
        Applied {
            district,
            result: RESULT_APPLIED,
            events: vec![
                Event::Roadwork {
                    segment,
                    change: ROAD_ADDED,
                    a,
                    b,
                },
                Event::Ledger {
                    reason: LEDGER_BUILD,
                    earned: 0,
                    spent: cost,
                },
            ],
        }
    }

    pub(super) fn remove_road(&mut self, segment: u32) -> Applied {
        let Some(seg) = self.city.segments.get(segment as usize) else {
            return Applied::refused(0, REFUSED_UNKNOWN);
        };
        let (a, b) = (seg.a, seg.b);
        let district = self.node_district(a).unwrap_or(0);
        if !seg.built || seg.removed {
            return Applied::refused(district, REFUSED_NOT_BUILT);
        }
        if self.funds() < economy::REMOVE_ROAD_COST as i64 {
            return Applied::refused(district, REFUSED_NO_FUNDS);
        }
        self.take_away(segment).expect("checked above");
        self.accounts[usize::from(district)] -= economy::REMOVE_ROAD_COST as i64;
        Applied {
            district,
            result: RESULT_APPLIED,
            events: vec![
                Event::Roadwork {
                    segment,
                    change: ROAD_REMOVED,
                    a,
                    b,
                },
                Event::Ledger {
                    reason: LEDGER_DEMOLISH,
                    earned: 0,
                    spent: economy::REMOVE_ROAD_COST,
                },
            ],
        }
    }

    /// Takes a built segment out of the city and marks it for the next step to
    /// move its vehicles off.
    pub(super) fn take_away(&mut self, segment: u32) -> Result<(), RoadError> {
        self.city.remove_road(segment)?;
        self.removed.push(segment);
        self.roads_changed();
        Ok(())
    }

    /// What follows from the road network changing: room for the new segment's
    /// cars, and upkeep for the roads there are now.
    pub(super) fn roads_changed(&mut self) {
        self.cars.resize(self.city.segments.len(), 0);
        self.upkeep = economy::upkeep_base(&self.city);
    }
}

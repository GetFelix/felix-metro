//! Roads builders add and take away after the city is generated.
//!
//! A built road joins two nodes that already exist, along one row or column,
//! over bare ground and clear of every other road. So it adds an edge to the
//! graph and never a node, and the graph stays connected. Segment ids are
//! never reused: a removed segment keeps its place in [`City::segments`].
//! See `docs/design.md`, "Roads".

use super::roads::{EAST, NORTH, SOUTH, WEST};
use crate::record::{
    REFUSED_MALFORMED, REFUSED_NOT_BUILT, REFUSED_NOT_STRAIGHT, REFUSED_ROAD_BLOCKED,
    REFUSED_ROAD_EXISTS, REFUSED_TOO_LONG, REFUSED_UNKNOWN,
};

use super::{City, Door, Lot, RoadPiece, RoadTile, Segment, SegmentClass, piece_of};

/// The longest built segment, in tiles.
pub const MAX_ROAD_LENGTH: u16 = 12;

/// Why a road could not be added or removed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RoadError {
    /// A node index past the end of the city.
    UnknownNode,
    /// The nodes are the same, or not in one row or column.
    NotInLine,
    /// The segment would be longer than [`MAX_ROAD_LENGTH`].
    TooLong,
    /// A segment already joins the two nodes.
    Joined,
    /// A tile between the nodes is road, water or outside the city, or has a road beside it.
    Blocked,
    /// A segment index past the end of the segment list.
    UnknownSegment,
    /// The segment is generated, or already removed.
    NotBuilt,
    /// Roads were restored out of order, or onto a city that already has built ones.
    Order,
}

impl std::fmt::Display for RoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            RoadError::UnknownNode => "no such node",
            RoadError::NotInLine => "the nodes are not two in one row or column",
            RoadError::TooLong => "the road is longer than 12 tiles",
            RoadError::Joined => "a road already joins these nodes",
            RoadError::Blocked => "the ground between the nodes is not free",
            RoadError::UnknownSegment => "no such segment",
            RoadError::NotBuilt => "not a road a builder added, or already removed",
            RoadError::Order => "roads out of order",
        })
    }
}

impl std::error::Error for RoadError {}

impl RoadError {
    /// The `command` event result a refusal of this kind is recorded with.
    pub fn refusal(self) -> u8 {
        match self {
            RoadError::UnknownNode | RoadError::UnknownSegment => REFUSED_UNKNOWN,
            RoadError::NotInLine => REFUSED_NOT_STRAIGHT,
            RoadError::TooLong => REFUSED_TOO_LONG,
            RoadError::Joined => REFUSED_ROAD_EXISTS,
            RoadError::Blocked => REFUSED_ROAD_BLOCKED,
            RoadError::NotBuilt => REFUSED_NOT_BUILT,
            RoadError::Order => REFUSED_MALFORMED,
        }
    }
}

/// A built segment as a keyframe lists it: enough to lay it again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuiltRoad {
    pub segment: u32,
    pub a: u32,
    pub b: u32,
    pub removed: bool,
}

impl City {
    /// Whether a road tile stands on `(x, z)`.
    pub fn is_road(&self, x: u16, z: u16) -> bool {
        self.tile_index(x, z).is_ok()
    }

    /// A door at `node`, on the first segment that meets it. Built segments join
    /// a node after the generated ones, and a node always has a generated one, so
    /// this is never a built segment, which is what lets a page that has not
    /// heard of every road agree with the sim on a route that starts here.
    pub fn node_door(&self, node: u32) -> Door {
        let &(_, segment) = self.adjacency[node as usize]
            .first()
            .expect("every node has a generated segment");
        let seg = &self.segments[segment as usize];
        Door {
            segment,
            offset: if seg.a == node { 0 } else { seg.length },
        }
    }

    /// The lot on tile `(x, z)`, if there is one: road and water tiles have none.
    pub fn lot_at(&self, x: u16, z: u16) -> Option<&Lot> {
        self.lots.iter().find(|l| l.x == x && l.z == z)
    }

    /// The tiles strictly between nodes `a` and `b` that a road would cover,
    /// if one may be built there. This is every rule a road has that depends
    /// on the roads and the land alone; whether a resident or a building is
    /// on a tile, and whether the city can pay, are the sim's to decide.
    pub fn road_tiles(&self, a: u32, b: u32) -> Result<Vec<(u16, u16)>, RoadError> {
        let (&(ax, az), &(bx, bz)) = self
            .nodes
            .get(a as usize)
            .zip(self.nodes.get(b as usize))
            .ok_or(RoadError::UnknownNode)?;
        if a == b || (ax != bx && az != bz) {
            return Err(RoadError::NotInLine);
        }
        if self.adjacency[a as usize].iter().any(|&(n, _)| n == b) {
            return Err(RoadError::Joined);
        }
        let length = ax.abs_diff(bx) + az.abs_diff(bz);
        if length > MAX_ROAD_LENGTH {
            return Err(RoadError::TooLong);
        }
        let (dx, dz) = (
            (i32::from(bx) - i32::from(ax)).signum(),
            (i32::from(bz) - i32::from(az)).signum(),
        );
        let tiles: Vec<(u16, u16)> = (1..length)
            .map(|k| {
                (
                    (i32::from(ax) + dx * i32::from(k)) as u16,
                    (i32::from(az) + dz * i32::from(k)) as u16,
                )
            })
            .collect();
        if tiles.is_empty() {
            return Err(RoadError::Joined);
        }
        for &(x, z) in &tiles {
            // Along the line the neighbours are the next tile or a node; across it there must be no road.
            let (px, pz) = (dz.abs(), dx.abs());
            let (x, z) = (i32::from(x), i32::from(z));
            let beside = self.is_road_at(x - px, z - pz) || self.is_road_at(x + px, z + pz);
            if beside
                || self.is_road(x as u16, z as u16)
                || self.lot_at(x as u16, z as u16).is_none()
            {
                return Err(RoadError::Blocked);
            }
        }
        Ok(tiles)
    }

    /// Adds a straight street between nodes `a` and `b` and returns its segment
    /// id, the next one. See [`City::road_tiles`] for what refuses it.
    pub fn add_road(&mut self, a: u32, b: u32) -> Result<u32, RoadError> {
        let tiles = self.road_tiles(a, b)?;
        Ok(self.push_built(a, b, false, Some(&tiles)))
    }

    /// Takes away a segment a builder added. Its tiles stop being road, and it
    /// leaves the graph but keeps its id.
    pub fn remove_road(&mut self, segment: u32) -> Result<(), RoadError> {
        let seg = self
            .segments
            .get(segment as usize)
            .ok_or(RoadError::UnknownSegment)?;
        if !seg.built || seg.removed {
            return Err(RoadError::NotBuilt);
        }
        let (a, b) = (seg.a, seg.b);
        self.segments[segment as usize].removed = true;
        self.adjacency[a as usize].retain(|&(_, s)| s != segment);
        self.adjacency[b as usize].retain(|&(_, s)| s != segment);
        for (x, z) in self.between(a, b) {
            if let Ok(i) = self.tile_index(x, z) {
                self.roads.remove(i);
            }
        }
        self.refresh(self.nodes[a as usize]);
        self.refresh(self.nodes[b as usize]);
        Ok(())
    }

    /// Lays the built roads a keyframe lists, in segment order, on a city that has
    /// none. This is how a page, or a sim that restarts, gets the city the log
    /// describes. The roads are laid as listed without the checks of
    /// [`City::add_road`], since they passed them when they were added. An id
    /// that is skipped, because that road's district has not been read yet,
    /// holds a removed placeholder so the ones after it keep their ids.
    pub fn restore_roads(&mut self, roads: &[BuiltRoad]) -> Result<(), RoadError> {
        if self.segments.iter().any(|s| s.built) {
            return Err(RoadError::Order);
        }
        for road in roads {
            if (road.segment as usize) < self.segments.len() {
                return Err(RoadError::Order);
            }
            while self.segments.len() < road.segment as usize {
                self.push_built(0, 0, true, None);
            }
            let (&(ax, az), &(bx, bz)) = self
                .nodes
                .get(road.a as usize)
                .zip(self.nodes.get(road.b as usize))
                .ok_or(RoadError::UnknownNode)?;
            if road.a == road.b || (ax != bx && az != bz) {
                return Err(RoadError::NotInLine);
            }
            if road.removed {
                self.push_built(road.a, road.b, true, None);
            } else {
                let tiles = self.between(road.a, road.b);
                self.push_built(road.a, road.b, false, Some(&tiles));
            }
        }
        Ok(())
    }

    /// Appends a built segment. `tiles` are the ones it covers; `None` for a
    /// segment that is already removed, which touches nothing.
    fn push_built(&mut self, a: u32, b: u32, removed: bool, tiles: Option<&[(u16, u16)]>) -> u32 {
        let id = self.segments.len() as u32;
        let built = self.segments.iter().filter(|s| s.built).count();
        self.streets.push(format!("Link Road {}", built + 1));
        let (na, nb) = (self.nodes[a as usize], self.nodes[b as usize]);
        let length = if removed && a == b {
            0
        } else {
            na.0.abs_diff(nb.0) + na.1.abs_diff(nb.1)
        };
        self.segments.push(Segment {
            id,
            a,
            b,
            class: SegmentClass::Street,
            length,
            speed: SegmentClass::Street.speed(),
            street: (self.streets.len() - 1) as u16,
            built: true,
            removed,
        });
        if let Some(tiles) = tiles {
            self.adjacency[a as usize].push((b, id));
            self.adjacency[b as usize].push((a, id));
            for &(x, z) in tiles {
                if let Err(at) = self.tile_index(x, z) {
                    self.roads.insert(
                        at,
                        RoadTile {
                            x,
                            z,
                            piece: RoadPiece::Straight,
                            rot: 0,
                            mask: 0,
                            avenue: false,
                        },
                    );
                }
            }
            for &(x, z) in tiles {
                self.refresh((x, z));
            }
            self.refresh(na);
            self.refresh(nb);
        }
        id
    }

    /// The tiles strictly between two nodes in one row or column.
    fn between(&self, a: u32, b: u32) -> Vec<(u16, u16)> {
        let (na, nb) = (self.nodes[a as usize], self.nodes[b as usize]);
        let (dx, dz) = (
            (i32::from(nb.0) - i32::from(na.0)).signum(),
            (i32::from(nb.1) - i32::from(na.1)).signum(),
        );
        (1..na.0.abs_diff(nb.0) + na.1.abs_diff(nb.1))
            .map(|k| {
                (
                    (i32::from(na.0) + dx * i32::from(k)) as u16,
                    (i32::from(na.1) + dz * i32::from(k)) as u16,
                )
            })
            .collect()
    }

    /// Where the road tile `(x, z)` is in [`City::roads`], or where it would go. The
    /// list is kept in rows, as the generator makes it.
    fn tile_index(&self, x: u16, z: u16) -> Result<usize, usize> {
        self.roads.binary_search_by_key(&(z, x), |r| (r.z, r.x))
    }

    fn is_road_at(&self, x: i32, z: i32) -> bool {
        u16::try_from(x)
            .ok()
            .zip(u16::try_from(z).ok())
            .is_some_and(|(x, z)| self.is_road(x, z))
    }

    /// Works out a tile's piece again from the road beside it.
    fn refresh(&mut self, (x, z): (u16, u16)) {
        let Ok(i) = self.tile_index(x, z) else { return };
        let (x, z) = (i32::from(x), i32::from(z));
        let mut mask = 0;
        for (bit, dx, dz) in [(NORTH, 0, -1), (EAST, 1, 0), (SOUTH, 0, 1), (WEST, -1, 0)] {
            if self.is_road_at(x + dx, z + dz) {
                mask |= bit;
            }
        }
        let (piece, rot) = piece_of(mask);
        let tile = &mut self.roads[i];
        tile.mask = mask;
        tile.piece = piece;
        tile.rot = rot;
    }
}

#[cfg(test)]
mod tests;

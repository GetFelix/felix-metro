//! The table that maps a building kind to a Kenney pack and model. Ids are
//! positions in [`KINDS`], so new models are only ever appended.

/// A building kind: an index into [`KINDS`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct BuildingKind(pub u8);

/// The asset a kind draws.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KindInfo {
    pub pack: &'static str,
    pub model: &'static str,
}

const fn k(pack: &'static str, model: &'static str) -> KindInfo {
    KindInfo { pack, model }
}

impl BuildingKind {
    pub const COMMERCIAL_FIRST: u8 = 0;
    pub const COMMERCIAL_COUNT: usize = 14;
    pub const SKYSCRAPER_FIRST: u8 = 14;
    /// Skyscrapers a to d; the tower keeps e to itself.
    pub const SKYSCRAPER_COUNT: usize = 4;
    pub const HOUSE_FIRST: u8 = 19;
    pub const HOUSE_COUNT: usize = 10;
    pub const FACTORY_FIRST: u8 = 29;
    pub const FACTORY_COUNT: usize = 6;
    pub const LANDMARK_FIRST: u8 = 35;
    pub const LANDMARK_COUNT: usize = 3;
    pub const TREE_FIRST: u8 = 38;
    pub const TREE_COUNT: usize = 2;
    /// The Felix tower: `building-skyscraper-e`.
    pub const FELIX_TOWER: BuildingKind = BuildingKind(18);

    pub fn info(self) -> KindInfo {
        KINDS[usize::from(self.0)]
    }
}

pub const KINDS: [KindInfo; 40] = [
    k("commercial", "building-a"),
    k("commercial", "building-b"),
    k("commercial", "building-c"),
    k("commercial", "building-d"),
    k("commercial", "building-e"),
    k("commercial", "building-f"),
    k("commercial", "building-g"),
    k("commercial", "building-h"),
    k("commercial", "building-i"),
    k("commercial", "building-j"),
    k("commercial", "building-k"),
    k("commercial", "building-l"),
    k("commercial", "building-m"),
    k("commercial", "building-n"),
    k("commercial", "building-skyscraper-a"),
    k("commercial", "building-skyscraper-b"),
    k("commercial", "building-skyscraper-c"),
    k("commercial", "building-skyscraper-d"),
    k("commercial", "building-skyscraper-e"),
    k("suburban", "building-type-a"),
    k("suburban", "building-type-b"),
    k("suburban", "building-type-c"),
    k("suburban", "building-type-d"),
    k("suburban", "building-type-e"),
    k("suburban", "building-type-f"),
    k("suburban", "building-type-g"),
    k("suburban", "building-type-h"),
    k("suburban", "building-type-i"),
    k("suburban", "building-type-j"),
    k("industrial", "building-a"),
    k("industrial", "building-b"),
    k("industrial", "building-c"),
    k("industrial", "building-d"),
    k("industrial", "building-e"),
    k("industrial", "building-f"),
    k("industrial", "water-tower"),
    k("industrial", "chimney-large"),
    k("industrial", "detail-tank-large"),
    k("suburban", "tree-large"),
    k("suburban", "tree-small"),
];
